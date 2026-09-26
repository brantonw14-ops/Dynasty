import { db } from '../db'
import type {
  Conference,
  DraftPickLogEntry,
  Division,
  GameResult,
  PendingTradeOffer,
  Player,
  PlayoffRound,
  Position,
  Team,
  TradedPick,
  TradePickRef,
} from '../types'
import { generateDraftClass, generateDraftClassPositions, prospectToPlayer, type CollegeProspect } from './draft'
import { computeCapSpace, expireContractsWithAiRetention, runFreeAgency } from './freeAgency'
import { simGame, type PlayerBoxScore } from './gameSim'
import { applyGamePerformance } from './inSeasonProgression'
import { advanceInjuries, rollNewInjuries } from './injuries'
import {
  classifyTeamOutlook,
  generateRosterForTeam,
  generateStreetFreeAgents,
  isStarterInRoster,
  MIN_ROSTER_SIZE,
  nextDepthOrder,
  rosterNeeds,
  type TeamOutlook,
} from './players'
import { progressPlayer } from './progression'
import { ageAndRetire } from './retirement'
import { createRng } from './rng'
import { marketSalary } from './salary'
import { generateSchedule } from './schedule'
import { adjustPotentialForSeason } from './seasonPerformance'
import { computeConferenceSeeds, computeStandings, type PlayoffSeed } from './standings'
import { generateTeams, SALARY_CAP } from './teams'
import { evaluateTrade, pickValue, playerValue, type TradeEvaluation } from './trades'

export interface TeamPreview {
  index: number
  region: string
  name: string
  abbrev: string
  conference: Conference
  division: Division
  overall: number
  avgAge: number
  capSpace: number
  outlook: TeamOutlook
}

/**
 * Generates the same 32 team rosters createLeague would for this seed,
 * purely in memory (no DB writes), so the team picker can show accurate
 * overall/cap/outlook before the user commits to a league. Passing the
 * same seed into createLeague afterward reproduces this exactly - the
 * generation order (team list, then roster-per-team) and RNG consumption
 * are identical either way, so the preview never lies about what you get.
 */
export function previewLeagueTeams(seed: number): TeamPreview[] {
  const rng = createRng(seed)
  const drafts = generateTeams()
  return drafts.map((d, i) => {
    const roster = generateRosterForTeam(rng, i) as Player[]
    const overall = Math.round(roster.reduce((sum, p) => sum + p.ratings.overall, 0) / roster.length)
    const avgAge =
      Math.round((roster.reduce((sum, p) => sum + p.age, 0) / roster.length) * 10) / 10
    const capSpace = SALARY_CAP - roster.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
    return {
      index: i,
      region: d.region,
      name: d.name,
      abbrev: d.abbrev,
      conference: d.conference,
      division: d.division,
      overall,
      avgAge,
      capSpace,
      outlook: classifyTeamOutlook(roster),
    }
  })
}

export async function createLeague(name: string, userTeamIndex: number, seed = Date.now()) {
  const rng = createRng(seed)
  const season = new Date().getFullYear()

  const leagueId = await db.leagues.add({
    id: 0,
    name,
    season,
    week: 1,
    regularSeasonWeeks: 1,
    phase: 'regular',
    champTeamId: null,
    userTeamId: null,
    createdAt: Date.now(),
  } as never)

  const teamDrafts = generateTeams()
  const teams: Team[] = []
  for (const draft of teamDrafts) {
    const id = await db.teams.add(draft as never)
    teams.push({ ...draft, id } as Team)
  }

  for (const team of teams) {
    const roster = generateRosterForTeam(rng, team.id)
    await db.players.bulkAdd(roster as never[])
  }

  // Seed a real day-one free agent pool - a fresh league shouldn't start
  // with nobody to sign, same as the real NFL always has replacement-level
  // guys unsigned even before any cuts or retirements happen.
  const streetFreeAgents = generateStreetFreeAgents(rng, 70)
  await db.players.bulkAdd(streetFreeAgents as never[])

  const userTeamId = teams[userTeamIndex]?.id ?? teams[0].id
  const regularSeasonWeeks = await generateAndStoreSchedule(leagueId as number, teams, season, rng)

  await db.leagues.update(leagueId as number, { userTeamId, regularSeasonWeeks })

  return leagueId as number
}

async function generateAndStoreSchedule(
  leagueId: number,
  teams: Team[],
  season: number,
  rng: () => number,
) {
  const schedule = generateSchedule(teams, season, rng)
  await db.schedule.bulkAdd(schedule.map((g) => ({ leagueId, season, ...g })) as never[])
  return schedule.reduce((max, g) => Math.max(max, g.week), 0)
}

export async function deleteLeague(leagueId: number) {
  // The app only ever holds one league's data at a time (teams/players/etc.
  // aren't scoped by leagueId elsewhere), so wiping these tables outright is
  // both correct and, critically, fast: table.clear() is a single native
  // IndexedDB op, where a filtered bulkDelete walks a cursor and collects
  // keys first - a season's worth of playerGameStats is ~16k rows, and that
  // path took minutes instead of milliseconds.
  await db.transaction(
    'rw',
    [db.leagues, db.teams, db.players, db.games, db.schedule, db.playerGameStats],
    async () => {
      await db.players.clear()
      await db.teams.clear()
      await db.games.clear()
      await db.schedule.clear()
      await db.playerGameStats.clear()
      await db.leagues.delete(leagueId)
    },
  )
}

async function persistBoxScore(
  leagueId: number,
  season: number,
  week: number,
  gameId: number,
  teamId: number,
  box: Map<number, PlayerBoxScore>,
) {
  if (box.size === 0) return
  const rows = [...box.values()].map((b) => ({
    leagueId,
    season,
    week,
    gameId,
    teamId,
    playerId: b.playerId,
    position: b.position,
    passYards: b.passYards,
    passTDs: b.passTDs,
    passAttempts: b.passAttempts,
    passCompletions: b.passCompletions,
    interceptions: b.interceptions,
    rushYards: b.rushYards,
    rushAttempts: b.rushAttempts,
    rushTDs: b.rushTDs,
    recYards: b.recYards,
    recTDs: b.recTDs,
    receptions: b.receptions,
    tackles: b.tackles,
    sacks: b.sacks,
    tacklesForLoss: b.tacklesForLoss,
    passBreakups: b.passBreakups,
    defInterceptions: b.defInterceptions,
    yardsAllowed: b.yardsAllowed,
    passerRatingAllowed: b.passerRatingAllowed,
    pancakes: b.pancakes,
    sacksAllowed: b.sacksAllowed,
    tflsAllowed: b.tflsAllowed,
    fieldGoalsMade: b.fieldGoalsMade,
    fieldGoalsAttempted: b.fieldGoalsAttempted,
    longestFieldGoal: b.longestFieldGoal,
    extraPointsMade: b.extraPointsMade,
    extraPointsAttempted: b.extraPointsAttempted,
    puntCount: b.puntCount,
    puntYards: b.puntYards,
  }))
  await db.playerGameStats.bulkAdd(rows as never[])
}

async function simRegularSeasonWeek(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

  const weekGames = await db.schedule
    .where({ leagueId, season: league.season, week: league.week })
    .toArray()
  const rng = createRng(league.season * 1000 + league.week)

  // Collect all injury/performance updates across the whole week's games
  // and write them in one bulkPut at the end - one bulkPut per game (32/week
  // at full strength) was the difference between a week taking ~100ms and
  // ~7s. Merged by player id since injuries and performance nudges are
  // computed independently and must not clobber each other.
  const playerUpdateMap = new Map<number, Player>()

  for (const g of weekGames) {
    const homeRosterFull = await db.players.where('teamId').equals(g.homeTeamId).toArray()
    const awayRosterFull = await db.players.where('teamId').equals(g.awayTeamId).toArray()
    const homeRoster = homeRosterFull.filter((p) => !p.injury)
    const awayRoster = awayRosterFull.filter((p) => !p.injury)
    const result = simGame(rng, homeRoster, awayRoster)
    const gameId = await db.games.add({
      leagueId,
      season: league.season,
      week: league.week,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: result.homeScore,
      awayScore: result.awayScore,
    } as never)
    await persistBoxScore(leagueId, league.season, league.week, gameId as number, g.homeTeamId, result.homeBox)
    await persistBoxScore(leagueId, league.season, league.week, gameId as number, g.awayTeamId, result.awayBox)

    mergePlayerUpdates(playerUpdateMap, [...homeRosterFull, ...awayRosterFull], [
      ...changedInjuries(homeRosterFull, rollNewInjuries(rng, homeRosterFull)),
      ...changedInjuries(awayRosterFull, rollNewInjuries(rng, awayRosterFull)),
    ])
    mergePlayerUpdates(playerUpdateMap, [...homeRoster, ...awayRoster], [
      ...applyGamePerformance(rng, homeRoster, result.homeBox),
      ...applyGamePerformance(rng, awayRoster, result.awayBox),
    ])
  }

  if (playerUpdateMap.size > 0) {
    await db.players.bulkPut([...playerUpdateMap.values()] as never[])
  }

  // Free agency has real churn week to week even in-season - a couple of
  // new names hit the market most weeks (camp/roster cuts elsewhere,
  // players between teams), so the pool doesn't just shrink toward empty
  // as the user (or AI) signs people off it.
  const newFreeAgentCount = Math.floor(rng() * 3) // 0-2 per week
  if (newFreeAgentCount > 0) {
    await db.players.bulkAdd(generateStreetFreeAgents(rng, newFreeAgentCount) as never[])
  }

  const nextWeek = league.week + 1
  const isRegularSeasonOver = nextWeek > league.regularSeasonWeeks
  await db.leagues.update(leagueId, {
    week: nextWeek,
    phase: isRegularSeasonOver ? 'playoffs' : 'regular',
  })

  await generateTradeOffers(leagueId)
}

async function currentSeasonRegularGames(leagueId: number, season: number) {
  return db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.season === season && g.round === undefined)
    .toArray()
}

async function currentSeasonPlayoffGames(leagueId: number, season: number, round: PlayoffRound) {
  return db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.season === season && g.round === round)
    .toArray()
}

function winnerOf(g: GameResult) {
  return g.homeScore >= g.awayScore ? g.homeTeamId : g.awayTeamId
}

async function playGame(
  leagueId: number,
  season: number,
  week: number,
  round: PlayoffRound,
  homeTeamId: number,
  awayTeamId: number,
  rng: () => number,
) {
  const homeRosterFull = await db.players.where('teamId').equals(homeTeamId).toArray()
  const awayRosterFull = await db.players.where('teamId').equals(awayTeamId).toArray()
  const homeRoster = homeRosterFull.filter((p) => !p.injury)
  const awayRoster = awayRosterFull.filter((p) => !p.injury)
  const result = simGame(rng, homeRoster, awayRoster)
  const gameId = await db.games.add({
    leagueId,
    season,
    week,
    homeTeamId,
    awayTeamId,
    homeScore: result.homeScore,
    awayScore: result.awayScore,
    round,
  } as never)
  await persistBoxScore(leagueId, season, week, gameId as number, homeTeamId, result.homeBox)
  await persistBoxScore(leagueId, season, week, gameId as number, awayTeamId, result.awayBox)

  const updateMap = new Map<number, Player>()
  mergePlayerUpdates(updateMap, [...homeRosterFull, ...awayRosterFull], [
    ...changedInjuries(homeRosterFull, rollNewInjuries(rng, homeRosterFull)),
    ...changedInjuries(awayRosterFull, rollNewInjuries(rng, awayRosterFull)),
  ])
  mergePlayerUpdates(updateMap, [...homeRoster, ...awayRoster], [
    ...applyGamePerformance(rng, homeRoster, result.homeBox),
    ...applyGamePerformance(rng, awayRoster, result.awayBox),
  ])
  if (updateMap.size > 0) await db.players.bulkPut([...updateMap.values()] as never[])
}

/** Only the players whose injury actually changed - rollNewInjuries returns the same reference for the rest. */
function changedInjuries(before: Player[], after: Player[]): Player[] {
  return after.filter((p, i) => p !== before[i])
}

/**
 * Folds a batch of updates (full player objects from injuries, or partial
 * {id, ...changedFields} from performance nudges) into an accumulator map,
 * on top of whatever's already there for that player (falling back to
 * `base` the first time) - so injury and performance updates for the same
 * player in the same game merge instead of one clobbering the other.
 */
function mergePlayerUpdates(
  map: Map<number, Player>,
  base: Player[],
  updates: (Player | ({ id: number } & Partial<Player>))[],
) {
  const baseById = new Map(base.map((p) => [p.id, p]))
  for (const u of updates) {
    const current = map.get(u.id) ?? baseById.get(u.id)
    if (!current) continue
    map.set(u.id, { ...current, ...u })
  }
}

/** Reseeds a set of remaining playoff teams: best seed vs worst, others paired in order. */
function reseedMatchups(remaining: PlayoffSeed[]): [PlayoffSeed, PlayoffSeed][] {
  const sorted = [...remaining].sort((a, b) => a.seed - b.seed)
  const matchups: [PlayoffSeed, PlayoffSeed][] = []
  for (let i = 0; i < sorted.length / 2; i++) {
    matchups.push([sorted[i], sorted[sorted.length - 1 - i]])
  }
  return matchups
}

async function simPlayoffRound(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

  const teams = await db.teams.toArray()
  const rng = createRng(league.season * 1000 + 900 + league.week)
  const regularGames = await currentSeasonRegularGames(leagueId, league.season)

  const seedsByConference: Record<Conference, PlayoffSeed[]> = {
    AFC: computeConferenceSeeds(teams, regularGames, 'AFC'),
    NFC: computeConferenceSeeds(teams, regularGames, 'NFC'),
  }
  const seedOf = (teamId: number) =>
    seedsByConference.AFC.find((s) => s.teamId === teamId) ??
    seedsByConference.NFC.find((s) => s.teamId === teamId)!

  const wildcard = await currentSeasonPlayoffGames(leagueId, league.season, 'wildcard')
  const divisional = await currentSeasonPlayoffGames(leagueId, league.season, 'divisional')
  const conference = await currentSeasonPlayoffGames(leagueId, league.season, 'conference')
  const superbowl = await currentSeasonPlayoffGames(leagueId, league.season, 'superbowl')

  if (wildcard.length < 6) {
    for (const conf of ['AFC', 'NFC'] as Conference[]) {
      // Seed 1 has a bye this round.
      const [, s2, s3, s4, s5, s6, s7] = seedsByConference[conf]
      const matchups: [PlayoffSeed, PlayoffSeed][] = [
        [s2, s7],
        [s3, s6],
        [s4, s5],
      ]
      for (const [higher, lower] of matchups) {
        await playGame(leagueId, league.season, league.week, 'wildcard', higher.teamId, lower.teamId, rng)
      }
    }
    await db.leagues.update(leagueId, { week: league.week + 1 })
    return
  }

  if (divisional.length < 4) {
    for (const conf of ['AFC', 'NFC'] as Conference[]) {
      const confWildcardWinners = wildcard
        .filter((g) => seedsByConference[conf].some((s) => s.teamId === g.homeTeamId))
        .map(winnerOf)
      const byeSeed = seedsByConference[conf][0]
      const remaining = [byeSeed, ...confWildcardWinners.map((id) => seedOf(id))]
      const matchups = reseedMatchups(remaining)
      for (const [higher, lower] of matchups) {
        await playGame(leagueId, league.season, league.week, 'divisional', higher.teamId, lower.teamId, rng)
      }
    }
    await db.leagues.update(leagueId, { week: league.week + 1 })
    return
  }

  if (conference.length < 2) {
    for (const conf of ['AFC', 'NFC'] as Conference[]) {
      const confDivisionalWinners = divisional
        .filter((g) => seedsByConference[conf].some((s) => s.teamId === g.homeTeamId))
        .map(winnerOf)
        .map((id) => seedOf(id))
      const [higher, lower] = [...confDivisionalWinners].sort((a, b) => a.seed - b.seed)
      await playGame(leagueId, league.season, league.week, 'conference', higher.teamId, lower.teamId, rng)
    }
    await db.leagues.update(leagueId, { week: league.week + 1 })
    return
  }

  if (superbowl.length < 1) {
    const champs = conference.map(winnerOf).map((id) => seedOf(id))
    const [higher, lower] = [...champs].sort((a, b) => a.seed - b.seed)
    await playGame(leagueId, league.season, league.week, 'superbowl', higher.teamId, lower.teamId, rng)

    const finalGame = (await currentSeasonPlayoffGames(leagueId, league.season, 'superbowl'))[0]
    const champTeamId = winnerOf(finalGame)
    await db.leagues.update(leagueId, { week: league.week + 1, phase: 'complete', champTeamId })
    return
  }
}

/**
 * A real NFL team can't take the field short-handed - this is the one
 * point that actually blocks play: the start of a fresh regular season,
 * once the draft (and its up-to-7 new rookies) has already landed. Roster
 * moves are otherwise completely free-form the rest of the year - there's
 * no maximum, and a mid-season dip below 53 while shopping for a
 * replacement is fine.
 */
export async function checkRosterLegalForKickoff(leagueId: number): Promise<{ ok: true } | { ok: false; rosterSize: number }> {
  const league = await db.leagues.get(leagueId)
  if (!league || league.userTeamId == null || league.phase !== 'regular' || league.week !== 1) return { ok: true }
  const rosterSize = await db.players.where('teamId').equals(league.userTeamId).count()
  if (rosterSize >= MIN_ROSTER_SIZE) return { ok: true }
  return { ok: false, rosterSize }
}

export async function simWeek(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

  const rosterCheck = await checkRosterLegalForKickoff(leagueId)
  if (!rosterCheck.ok) {
    throw new Error(
      `Your roster has only ${rosterCheck.rosterSize} players - you need at least ${MIN_ROSTER_SIZE} to kick off the season. ` +
        `Sign more free agents, use Auto-Fill Roster, or if you're short on cap space, cut an expensive player to afford a couple of cheaper ones.`,
    )
  }

  // Heal existing injuries by a week before this week's games roll any new
  // ones, so a player hurt this week doesn't also get a week knocked off
  // the same injury before it's even started. Only the (typically small)
  // set of currently-injured players needs writing back - bulk-putting
  // every player in the league every week for a handful of real changes
  // is pure waste.
  const injuredPlayers = (await db.players.toArray()).filter((p) => p.injury)
  if (injuredPlayers.length > 0) {
    await db.players.bulkPut(advanceInjuries(injuredPlayers) as never[])
  }

  if (league.phase === 'regular') {
    await simRegularSeasonWeek(leagueId)
  } else if (league.phase === 'playoffs') {
    await simPlayoffRound(leagueId)
  }
}

async function draftOrderFor(leagueId: number, season: number, teams: Team[]) {
  const regularGames = await currentSeasonRegularGames(leagueId, season)
  const standings = computeStandings(teams, regularGames)
  return [...standings].reverse().map((s) => s.teamId)
}

/**
 * Offseason step 1: ages every player a year (with retirements and rating
 * progression) and lets expiring contracts hit free agency, then pauses the
 * league in the 'resign' phase - a window where the user can review their
 * own roster's contracts and cut players to free up cap space *before*
 * free agency opens, same as a real front office does. AI teams don't
 * touch free agency at all yet; that only happens once the user moves on
 * to `openFreeAgency` and then `beginDraft`.
 */
export async function advanceToFreeAgency(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'complete') throw new Error('Season is not finished yet')

  const rng = createRng(league.season * 7919 + 1)
  const allPlayers = await db.players.toArray()
  const seasonStats = await db.playerGameStats.where('[leagueId+season]').equals([leagueId, league.season]).toArray()

  const withUpdatedPotential = adjustPotentialForSeason(allPlayers, seasonStats)
  const { retiredIds, agedPlayers } = ageAndRetire(rng, withUpdatedPotential)
  const progressedPlayers = agedPlayers.map((p) => progressPlayer(rng, p))

  // AI teams get a chance to proactively re-sign a player whose deal is
  // expiring, same as real front offices do, before he'd ever reach the
  // open market - keeps free agency from being flooded with far more good
  // players than a real league's pool ever has. The user's own team is
  // excluded here: their expiring players stay on the roster with no
  // contract instead, showing up in the resign window as needing a
  // decision, so the user gets the same kind of chance manually.
  const finalPlayers = expireContractsWithAiRetention(rng, progressedPlayers, league.userTeamId)

  if (retiredIds.length > 0) await db.players.bulkDelete(retiredIds)
  await db.players.bulkPut(finalPlayers as never[])

  const freeAgentCount = finalPlayers.filter((p) => p.teamId === null).length

  const nextSeason = league.season + 1
  await db.leagues.update(leagueId, {
    season: nextSeason,
    phase: 'resign',
    champTeamId: null,
  })

  return { retiredCount: retiredIds.length, freeAgentCount }
}

/** Releases a player from their team, freeing up their cap hit and returning them to the free agent pool. */
export async function cutPlayer(leagueId: number, playerId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (!['resign', 'freeagency', 'draft', 'regular', 'playoffs'].includes(league.phase)) {
    throw new Error('Cannot cut players right now')
  }
  if (league.userTeamId == null) throw new Error('League has no user team')

  const player = await db.players.get(playerId)
  if (!player || player.teamId !== league.userTeamId) throw new Error('Player is not on your team')

  await db.players.update(playerId, { teamId: null, contract: null })
}

/**
 * Re-signs a player already on the user's team during the resign window -
 * either a just-expired contract (contract is null) or an extension of a
 * player who's still under one. Salary is the same market-rate curve used
 * everywhere else, shown to the user up front (no hidden RNG variance)
 * since this is a decision the user is actively making, not an AI auto-sign.
 */
export async function resignPlayer(leagueId: number, playerId: number, years: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'resign') throw new Error('Can only resign players before free agency opens')
  if (league.userTeamId == null) throw new Error('League has no user team')
  if (years < 1 || years > 4) throw new Error('Contract length must be between 1 and 4 years')

  const player = await db.players.get(playerId)
  if (!player || player.teamId !== league.userTeamId) throw new Error('Player is not on your team')

  const roster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  const capSpace = computeCapSpace(roster.filter((p) => p.id !== playerId))
  const salary = Math.round(marketSalary(player.position, player.ratings.overall, player.age))
  if (salary > capSpace) throw new Error('Not enough cap space for this contract')

  await db.players.update(playerId, { contract: { salary, yearsLeft: years } })
  return { salary }
}

/**
 * Closes the resign window and opens free agency for the user to shop the
 * pool. Any of the user's own players who weren't re-signed, extended, or
 * cut during the resign window (their contract expired and nothing was
 * decided) are released to free agency now, same as every other team's
 * uncontested expirations already were.
 */
export async function openFreeAgency(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'resign') throw new Error('Not in the resign window')
  if (league.userTeamId != null) {
    const undecided = await db.players
      .where('teamId')
      .equals(league.userTeamId)
      .and((p) => p.contract === null)
      .toArray()
    if (undecided.length > 0) {
      await db.players.bulkPut(undecided.map((p) => ({ ...p, teamId: null })) as never[])
    }
  }

  await db.leagues.update(leagueId, { phase: 'freeagency' })
}

/**
 * What a free agent is asking for: deterministic from their own id + the
 * season (same rng a real signing uses), so the UI can show this up front
 * before the user commits to an offer, not just find out after signing.
 */
export function estimateFreeAgentAsk(season: number, player: Player): { salary: number; years: number } {
  const rng = createRng(season * 7919 + player.id)
  const salary = Math.round(marketSalary(player.position, player.ratings.overall, player.age) * (0.9 + rng() * 0.25))
  const years = 1 + Math.floor(rng() * 3)
  return { salary, years }
}

/** Signs an available free agent to the user's team during the free agency window. */
export async function signFreeAgent(leagueId: number, playerId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  // Allowed both during the dedicated offseason free agency window and
  // during an in-progress season - real teams sign free agents (injury
  // replacements, cap casualties other teams pass on, etc.) all year, not
  // just in one offseason window.
  if (!['freeagency', 'regular', 'playoffs'].includes(league.phase)) {
    throw new Error('Free agency is not open right now')
  }
  if (league.userTeamId == null) throw new Error('League has no user team')

  const player = await db.players.get(playerId)
  if (!player || player.teamId !== null) throw new Error('Player is not a free agent')

  const roster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  if (!rosterNeeds(roster).includes(player.position)) {
    throw new Error(`Roster already full at ${player.position}`)
  }

  const capSpace = computeCapSpace(roster)
  const { salary, years } = estimateFreeAgentAsk(league.season, player)
  if (salary > capSpace) throw new Error('Not enough cap space to sign this player')

  await db.players.update(playerId, {
    teamId: league.userTeamId,
    contract: { salary, yearsLeft: years },
    depthOrder: nextDepthOrder(roster, player.position),
  })
}

/** Moves a player up or down their own team's depth chart at their position. */
export async function moveDepthChart(teamId: number, playerId: number, direction: 'up' | 'down') {
  const player = await db.players.get(playerId)
  if (!player || player.teamId !== teamId) throw new Error('Player is not on this team')

  const positionGroup = (await db.players.where('teamId').equals(teamId).toArray())
    .filter((p) => p.position === player.position)
    .sort((a, b) => a.depthOrder - b.depthOrder)

  const index = positionGroup.findIndex((p) => p.id === playerId)
  const swapIndex = direction === 'up' ? index - 1 : index + 1
  if (swapIndex < 0 || swapIndex >= positionGroup.length) return

  const other = positionGroup[swapIndex]
  await db.players.bulkPut([
    { ...player, depthOrder: other.depthOrder },
    { ...other, depthOrder: player.depthOrder },
  ] as never[])
}

/** Resets the whole team's depth chart to best-overall-first at every position - one click instead of reordering by hand. */
export async function optimizeDepthChart(teamId: number) {
  const roster = await db.players.where('teamId').equals(teamId).toArray()
  const byPosition = new Map<Position, Player[]>()
  for (const p of roster) {
    const list = byPosition.get(p.position) ?? []
    list.push(p)
    byPosition.set(p.position, list)
  }

  const updates: Player[] = []
  for (const group of byPosition.values()) {
    const sorted = [...group].sort((a, b) => b.ratings.overall - a.ratings.overall)
    sorted.forEach((p, i) => {
      if (p.depthOrder !== i) updates.push({ ...p, depthOrder: i })
    })
  }

  if (updates.length > 0) await db.players.bulkPut(updates as never[])
}

/** A real NFL draft is exactly 7 rounds; every team gets one pick each round unless it's been traded away. */
export const DRAFT_ROUNDS = 7

/** Who currently owns a given future draft pick - the original team, unless it's been traded (see League.tradedPicks). */
export function pickOwner(tradedPicks: TradedPick[] | undefined, year: number, round: number, originalTeamId: number): number {
  const entry = tradedPicks?.find((p) => p.year === year && p.round === round && p.originalTeamId === originalTeamId)
  return entry?.ownerTeamId ?? originalTeamId
}

/** Every future pick (up to `yearsAhead` seasons out) a team currently owns, across every original slot. */
export function ownedPicks(
  tradedPicks: TradedPick[] | undefined,
  currentSeason: number,
  allTeamIds: number[],
  teamId: number,
  yearsAhead = 5,
): TradePickRef[] {
  const picks: TradePickRef[] = []
  for (let yearsOut = 1; yearsOut <= yearsAhead; yearsOut++) {
    const year = currentSeason + yearsOut
    for (let round = 1; round <= DRAFT_ROUNDS; round++) {
      for (const originalTeamId of allTeamIds) {
        if (pickOwner(tradedPicks, year, round, originalTeamId) === teamId) {
          picks.push({ year, round, originalTeamId })
        }
      }
    }
  }
  return picks
}

/**
 * Offseason step 2: closes the user's free agency window by running AI
 * free agency (every team except the user's, signing from whatever's left
 * in the pool), then sets up an interactive rookie draft - 7 rounds, one
 * pick per team per round, worst record picks first, same order every
 * round (no snake, matching how the real NFL draft order works). The
 * prospect pool itself is never persisted (regenerated on demand from
 * draftSeed); only which prospects are taken and whose turn it is lives on
 * the league row. Auto-advances through any AI-only picks immediately so
 * the draft screen opens right on the user's first turn (or fully resolves
 * and rolls into the regular season if the user has no team).
 */
/**
 * Fills the user's roster up to a legal 53-man active roster by signing the
 * cheapest available free agents - a real team can't take the field short,
 * so this exists as the escape hatch when the user skips resigning/signing
 * on their own. Doesn't respect rosterNeeds (a forced fill may go over a
 * position's normal target count) or asking-price odds - just grabs whoever
 * is cheapest so it fits under the cap as often as possible.
 */
export async function autoFillRoster(leagueId: number): Promise<{ added: number }> {
  const league = await db.leagues.get(leagueId)
  if (!league || league.userTeamId == null) return { added: 0 }

  let roster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  const shortfall = MIN_ROSTER_SIZE - roster.length
  if (shortfall <= 0) return { added: 0 }

  const freeAgents = (await db.players.toArray())
    .filter((p) => p.teamId === null)
    .map((p) => ({ p, salary: Math.round(marketSalary(p.position, p.ratings.overall, p.age) * 0.9) }))
    .sort((a, b) => a.salary - b.salary)

  const signed: Player[] = []
  let capSpace = computeCapSpace(roster)
  for (const { p, salary } of freeAgents) {
    if (signed.length >= shortfall) break
    if (salary > capSpace) continue
    signed.push({ ...p, teamId: league.userTeamId, contract: { salary, yearsLeft: 1 }, depthOrder: nextDepthOrder(roster, p.position) })
    roster = [...roster, signed[signed.length - 1]]
    capSpace -= salary
  }

  if (signed.length > 0) await db.players.bulkPut(signed as never[])
  return { added: signed.length }
}

export async function beginDraft(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'freeagency') throw new Error('Not in the free agency window')
  // No roster-size gate here on purpose: the draft itself adds up to 7
  // players (one per round), so a team a handful of players short of 53
  // going in is completely normal and expected - the real check is after
  // the draft, once those rookies have actually landed on the roster.

  const rng = createRng(league.season * 7919 + 2)
  const teams = await db.teams.toArray()
  const allPlayers = await db.players.toArray()
  const draftOrderTeamIds = await draftOrderFor(leagueId, league.season - 1, teams)

  const rostersByTeam = new Map<number, Player[]>()
  for (const team of teams) {
    rostersByTeam.set(
      team.id,
      allPlayers.filter((p) => p.teamId === team.id),
    )
  }
  const freeAgents = allPlayers.filter((p) => p.teamId === null)
  const excludeTeamIds = new Set(league.userTeamId != null ? [league.userTeamId] : [])
  const signings = runFreeAgency(rng, teams, rostersByTeam, freeAgents, draftOrderTeamIds, excludeTeamIds)
  // runFreeAgency already pushes each signed player into rostersByTeam as it
  // signs them (so later signings in the same pass see accurate cap/needs),
  // so only the DB write is left to do here.
  if (signings.length > 0) {
    await db.players.bulkPut(signings.map((s) => s.player) as never[])
  }

  // Exactly 7 rounds x one pick per team, like the real draft - the class's
  // position mix reflects the league-wide roster shape, not any one team's
  // needs, since every team drafts regardless of whether they "need" that
  // pick this round.
  const draftSeed = league.season * 7919 + 3
  const totalPicks = draftOrderTeamIds.length * DRAFT_ROUNDS
  const draftPositions = generateDraftClassPositions(league.season * 7919 + 5, totalPicks)

  await db.leagues.update(leagueId, {
    phase: 'draft',
    draftSeed,
    draftPositions,
    draftOrderTeamIds,
    draftOrderIndex: 0,
    draftPickedIndices: [],
    draftLog: [],
  })

  await advanceDraft(leagueId, { stopBeforeUserTurn: true })
}

/** Everything the draft board UI needs: the (deterministically regenerated) prospect pool, who's taken, and whose turn it is. */
export interface DraftBoardState {
  prospects: CollegeProspect[]
  pickedIndices: Set<number>
  currentTeamId: number | null
  isUserTurn: boolean
  pickNumber: number
  totalPicks: number
  round: number
  totalRounds: number
  pickInRound: number
  picksPerRound: number
  log: DraftPickLogEntry[]
}

export async function getDraftBoard(leagueId: number): Promise<DraftBoardState | null> {
  const league = await db.leagues.get(leagueId)
  if (!league || league.phase !== 'draft' || !league.draftPositions || !league.draftOrderTeamIds) return null

  const prospects = generateDraftClass(league.draftSeed ?? 0, league.draftPositions)
  const pickedIndices = new Set(league.draftPickedIndices ?? [])
  const order = league.draftOrderTeamIds
  const orderIndex = league.draftOrderIndex ?? 0
  const currentRound = order.length > 0 ? Math.floor(orderIndex / order.length) + 1 : 1
  const currentOriginalTeamId = order.length > 0 ? order[orderIndex % order.length] : null
  const currentTeamId =
    currentOriginalTeamId != null ? pickOwner(league.tradedPicks, league.season, currentRound, currentOriginalTeamId) : null
  const pickNumber = (league.draftLog?.length ?? 0) + 1

  return {
    prospects,
    pickedIndices,
    currentTeamId,
    isUserTurn: currentTeamId != null && currentTeamId === league.userTeamId,
    pickNumber,
    totalPicks: prospects.length,
    round: Math.min(DRAFT_ROUNDS, Math.floor((pickNumber - 1) / order.length) + 1),
    totalRounds: DRAFT_ROUNDS,
    pickInRound: ((pickNumber - 1) % order.length) + 1,
    picksPerRound: order.length,
    log: league.draftLog ?? [],
  }
}

/**
 * Picks the best prospect still on the board for a team: prefers a position
 * they actually still need (real roster shape, not just "have zero"), and
 * only falls back to best-player-available once every remaining need is
 * filled - same as a real team drafting for value once their obvious holes
 * are addressed.
 */
function bestAvailableFor(prospects: CollegeProspect[], picked: Set<number>, needs: Position[]): CollegeProspect | undefined {
  const remaining = prospects.filter((p) => !picked.has(p.index))
  const needed = remaining.filter((p) => needs.includes(p.position)).sort((a, b) => b.ratings.overall - a.ratings.overall)
  if (needed.length > 0) return needed[0]
  return remaining.sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
}

/**
 * Auto-picks for every AI team's turn, stopping either at the user's next
 * turn or once all 7 rounds are complete (rolling straight into the
 * regular season in that case). `stopBeforeUserTurn: false` runs the whole
 * remaining draft with no pause, used when there's no user team to wait on.
 */
async function advanceDraft(leagueId: number, { stopBeforeUserTurn }: { stopBeforeUserTurn: boolean }) {
  const league = await db.leagues.get(leagueId)
  if (!league || league.phase !== 'draft') return
  if (!league.draftPositions || !league.draftOrderTeamIds) return

  const prospects = generateDraftClass(league.draftSeed ?? 0, league.draftPositions)
  const order = league.draftOrderTeamIds
  const picked = new Set(league.draftPickedIndices ?? [])
  const log = [...(league.draftLog ?? [])]
  let orderIndex = league.draftOrderIndex ?? 0

  while (picked.size < prospects.length) {
    const round = Math.floor(orderIndex / order.length) + 1
    const originalTeamId = order[orderIndex % order.length]
    const teamId = pickOwner(league.tradedPicks, league.season, round, originalTeamId)
    if (stopBeforeUserTurn && teamId === league.userTeamId) break

    const roster = await db.players.where('teamId').equals(teamId).toArray()
    const needs = rosterNeeds(roster)
    const best = bestAvailableFor(prospects, picked, needs)
    if (!best) break // shouldn't happen - totalPicks always matches prospects.length

    const depthOrder = nextDepthOrder(roster, best.position)
    await db.players.add(prospectToPlayer(best, teamId, depthOrder) as never)
    picked.add(best.index)
    log.push({ pickNumber: log.length + 1, teamId, prospectIndex: best.index })
    orderIndex++
  }

  await db.leagues.update(leagueId, {
    draftOrderIndex: orderIndex,
    draftPickedIndices: [...picked],
    draftLog: log,
  })

  if (picked.size >= prospects.length) {
    await finalizeDraft(leagueId)
  }
}

/** Makes the user's own draft pick, then auto-advances through any AI turns up to the user's next pick (or the end of the draft). */
export async function makeUserDraftPick(leagueId: number, prospectIndex: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'draft') throw new Error('Not currently drafting')
  if (league.userTeamId == null) throw new Error('League has no user team')
  if (!league.draftPositions || !league.draftOrderTeamIds) throw new Error('Draft has not been set up')

  const order = league.draftOrderTeamIds
  const orderIndex = league.draftOrderIndex ?? 0
  const round = Math.floor(orderIndex / order.length) + 1
  const originalTeamId = order[orderIndex % order.length]
  const currentTeamId = pickOwner(league.tradedPicks, league.season, round, originalTeamId)
  if (currentTeamId !== league.userTeamId) throw new Error("It's not your turn to pick")

  const picked = new Set(league.draftPickedIndices ?? [])
  if (picked.has(prospectIndex)) throw new Error('That prospect has already been drafted')

  const prospects = generateDraftClass(league.draftSeed ?? 0, league.draftPositions)
  const prospect = prospects[prospectIndex]
  if (!prospect) throw new Error('Invalid prospect')

  const roster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  const depthOrder = nextDepthOrder(roster, prospect.position)
  await db.players.add(prospectToPlayer(prospect, league.userTeamId, depthOrder) as never)

  picked.add(prospectIndex)
  const log = [...(league.draftLog ?? []), { pickNumber: (league.draftLog?.length ?? 0) + 1, teamId: league.userTeamId, prospectIndex }]
  await db.leagues.update(leagueId, {
    draftOrderIndex: orderIndex + 1,
    draftPickedIndices: [...picked],
    draftLog: log,
  })

  await advanceDraft(leagueId, { stopBeforeUserTurn: true })
}

/**
 * Auto-picks the rest of the draft, including the user's remaining picks
 * (same best-player-available logic AI teams use) - an escape hatch for
 * when a user just wants to see the rookie class land and move on, or gets
 * stuck unable to make a pick for any reason.
 */
export async function simRestOfDraft(leagueId: number) {
  await advanceDraft(leagueId, { stopBeforeUserTurn: false })
}

async function finalizeDraft(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) return

  const teams = await db.teams.toArray()
  const rng = createRng(league.season * 7919 + 4)
  const regularSeasonWeeks = await generateAndStoreSchedule(leagueId, teams, league.season, rng)

  await db.leagues.update(leagueId, {
    week: 1,
    regularSeasonWeeks,
    phase: 'regular',
    draftSeed: undefined,
    draftPositions: undefined,
    draftOrderTeamIds: undefined,
    draftOrderIndex: undefined,
    draftPickedIndices: undefined,
    draftLog: undefined,
  })
}

/** Validates that every pick ref is currently owned by the given team, and returns their combined trade value. */
function resolvePickRefs(
  tradedPicks: TradedPick[] | undefined,
  currentSeason: number,
  teamId: number,
  refs: TradePickRef[],
): { valid: boolean; value: number } {
  let value = 0
  for (const ref of refs) {
    if (pickOwner(tradedPicks, ref.year, ref.round, ref.originalTeamId) !== teamId) {
      return { valid: false, value: 0 }
    }
    value += pickValue(ref.round, ref.year - currentSeason)
  }
  return { valid: true, value }
}

function sameRef(a: TradePickRef, b: TradePickRef) {
  return a.year === b.year && a.round === b.round && a.originalTeamId === b.originalTeamId
}

/** Re-homes a list of traded picks onto a fresh tradedPicks array (adds/updates entries, never removes history for picks not involved). */
function applyPickTransfers(existing: TradedPick[], transfers: { ref: TradePickRef; newOwnerTeamId: number }[]): TradedPick[] {
  const next = [...existing]
  for (const { ref, newOwnerTeamId } of transfers) {
    const idx = next.findIndex((p) => sameRef(p, ref))
    if (idx >= 0) next[idx] = { ...next[idx], ownerTeamId: newOwnerTeamId }
    else next.push({ ...ref, ownerTeamId: newOwnerTeamId })
  }
  return next
}

/**
 * Proposes a trade: teamA sends `giveIds`/`givePicks` and receives
 * `getIds`/`getPicks` from teamB. teamB (typically an AI team) evaluates it
 * from their own side, picks folded into the same value comparison as
 * players; if accepted, the trade executes immediately (players change
 * teamId, picks change ownership). Also blocks the deal if it would put
 * teamA over the salary cap - teamB's own roster-need and cap checks happen
 * inside evaluateTrade.
 */
export async function proposeTrade(
  leagueId: number,
  teamAId: number,
  teamBId: number,
  giveIds: number[],
  getIds: number[],
  givePicks: TradePickRef[] = [],
  getPicks: TradePickRef[] = [],
): Promise<TradeEvaluation> {
  const league = await db.leagues.get(leagueId)
  if (!league) return { accepted: false, reason: 'League not found' }

  const rosterA = await db.players.where('teamId').equals(teamAId).toArray()
  const rosterB = await db.players.where('teamId').equals(teamBId).toArray()

  const giving = rosterA.filter((p) => giveIds.includes(p.id))
  const getting = rosterB.filter((p) => getIds.includes(p.id))
  if (giving.length !== giveIds.length || getting.length !== getIds.length) {
    return { accepted: false, reason: 'Invalid player selection' }
  }

  const givePicksResolved = resolvePickRefs(league.tradedPicks, league.season, teamAId, givePicks)
  const getPicksResolved = resolvePickRefs(league.tradedPicks, league.season, teamBId, getPicks)
  if (!givePicksResolved.valid || !getPicksResolved.valid) {
    return { accepted: false, reason: 'Invalid draft pick selection' }
  }

  const evaluation = evaluateTrade(rosterB, getting, giving, getPicksResolved.value, givePicksResolved.value)
  if (!evaluation.accepted) return evaluation

  const capCheck = wouldFitUnderCap(rosterA, giveIds, getting)
  if (!capCheck) {
    return { accepted: false, reason: 'Would put your team over the salary cap' }
  }

  await executeTradeMechanics(leagueId, league.tradedPicks, rosterA, rosterB, giving, getting, teamAId, teamBId, givePicks, getPicks)

  return evaluation
}

export function wouldFitUnderCap(roster: Player[], leavingIds: number[], entering: Player[]): boolean {
  const leavingSet = new Set(leavingIds)
  const resulting = [...roster.filter((p) => !leavingSet.has(p.id)), ...entering]
  const capUsed = resulting.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
  return capUsed <= SALARY_CAP
}

/** The actual mechanical swap - player teamIds and pick ownership - shared by proposeTrade and acceptTradeOffer. */
async function executeTradeMechanics(
  leagueId: number,
  tradedPicks: TradedPick[] | undefined,
  rosterA: Player[],
  rosterB: Player[],
  giving: Player[],
  getting: Player[],
  teamAId: number,
  teamBId: number,
  givePicks: TradePickRef[],
  getPicks: TradePickRef[],
) {
  await db.players.bulkPut(
    giving.map((p) => ({ ...p, teamId: teamBId, depthOrder: nextDepthOrder(rosterB, p.position) })) as never[],
  )
  await db.players.bulkPut(
    getting.map((p) => ({ ...p, teamId: teamAId, depthOrder: nextDepthOrder(rosterA, p.position) })) as never[],
  )

  if (givePicks.length > 0 || getPicks.length > 0) {
    const nextTradedPicks = applyPickTransfers(tradedPicks ?? [], [
      ...givePicks.map((ref) => ({ ref, newOwnerTeamId: teamBId })),
      ...getPicks.map((ref) => ({ ref, newOwnerTeamId: teamAId })),
    ])
    await db.leagues.update(leagueId, { tradedPicks: nextTradedPicks })
  }
}

/** Flags/unflags one of the user's own players as available in trade talks - AI teams periodically shop offers for blocked players. */
export async function toggleTradeBlock(playerId: number) {
  const player = await db.players.get(playerId)
  if (!player) throw new Error('Player not found')
  await db.players.update(playerId, { onTradeBlock: !player.onTradeBlock })
}

/**
 * Looks at the user's trade-block players and, with some randomness, has
 * one AI team put together an offer for one of them - a player (and
 * sometimes a sweetener pick) the AI team can actually afford/use, sized so
 * the deal is at least fair value for the user (this is meant to read as
 * "someone wants your guy," not a lowball). Skips entirely if there's
 * nothing on the block or too many offers are already pending.
 */
export async function generateTradeOffers(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league || league.userTeamId == null) return
  const pending = league.pendingTradeOffers ?? []
  if (pending.length >= 3) return

  const myRoster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  const blockPlayers = myRoster.filter((p) => p.onTradeBlock === true)
  // Trade-block players are the strongest signal (the user explicitly said
  // "shop this guy"), but AI teams should still occasionally come calling
  // on players that aren't blocked - real GMs call about players who
  // aren't on the block too. Falls back to the whole roster at lower odds.
  const candidatePool = blockPlayers.length > 0 ? blockPlayers : myRoster
  if (candidatePool.length === 0) return

  const rng = createRng(league.season * 104729 + league.week)
  const offerChance = blockPlayers.length > 0 ? 0.5 : 0.3
  if (rng() > offerChance) return // not every week produces an offer

  const alreadyOffered = new Set(pending.map((o) => o.requestPlayerIds[0]))
  const eligible = candidatePool.filter((p) => !alreadyOffered.has(p.id))
  const target = eligible[Math.floor(rng() * eligible.length)]
  if (!target) return

  const teams = await db.teams.toArray()
  const allTeamIds = teams.map((t) => t.id)
  const candidateTeamIds = allTeamIds.filter((id) => id !== league.userTeamId)
  const fromTeamId = candidateTeamIds[Math.floor(rng() * candidateTeamIds.length)]
  const fromRoster = await db.players.where('teamId').equals(fromTeamId).toArray()

  // "Need" here means either an actual roster shortage at that position, or
  // the blocked player would just be a clear upgrade over their current
  // starter there - a healthy 53-man roster rarely has a numeric shortage
  // (rosterNeeds only fires below the position's target count), but a real
  // team still wants to trade for a better starter even at a "full" spot.
  const needs = new Set(rosterNeeds(fromRoster))
  const currentBestAtPosition = fromRoster
    .filter((p) => p.position === target.position)
    .sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
  const wouldUpgrade = !currentBestAtPosition || target.ratings.overall > currentBestAtPosition.ratings.overall + 3
  if (!needs.has(target.position) && !wouldUpgrade) return

  const targetValue = playerValue(target)
  const capSpace = computeCapSpace(fromRoster)
  if ((target.contract?.salary ?? 0) > capSpace) return // can't actually afford the contract

  // Build a "give" package from the offering team's own surplus (positions
  // they're not short on), aiming to clear the target's value with a
  // little extra so it reads as a good offer for the user.
  const fromNeeds = new Set(needs)
  const surplus = fromRoster
    .filter((p) => !fromNeeds.has(p.position) && p.ratings.overall < target.ratings.overall + 10)
    .sort((a, b) => playerValue(b) - playerValue(a))

  const offerPlayers: Player[] = []
  let offerValue = 0
  for (const p of surplus) {
    if (offerValue >= targetValue * 1.1) break
    offerPlayers.push(p)
    offerValue += playerValue(p)
    if (offerPlayers.length >= 2) break
  }

  let offerPicks: TradePickRef[] = []
  if (offerValue < targetValue) {
    const picks = ownedPicks(league.tradedPicks, league.season, allTeamIds, fromTeamId, 3).sort(
      (a, b) => pickValue(a.round, a.year - league.season) - pickValue(b.round, b.year - league.season),
    )
    for (const ref of picks) {
      const v = pickValue(ref.round, ref.year - league.season)
      if (offerValue >= targetValue) break
      offerPicks.push(ref)
      offerValue += v
      if (offerPicks.length >= 2) break
    }
  }

  if (offerValue < targetValue * 0.9 || (offerPlayers.length === 0 && offerPicks.length === 0)) return

  const offer: PendingTradeOffer = {
    id: league.nextTradeOfferId ?? 1,
    fromTeamId,
    offerPlayerIds: offerPlayers.map((p) => p.id),
    offerPicks,
    requestPlayerIds: [target.id],
    requestPicks: [],
  }

  await db.leagues.update(leagueId, {
    pendingTradeOffers: [...pending, offer],
    nextTradeOfferId: offer.id + 1,
  })
}

/**
 * Accepts a pending AI trade offer exactly as proposed. Unlike proposeTrade
 * this does NOT re-run evaluateTrade's fairness check from the AI's side -
 * that check requires the "responding" team to come out ahead, but here the
 * AI is the one who initiated the offer specifically to overpay for a
 * player it wants, so the fairness decision was already made at generation
 * time. Still re-validates the mechanics (players/picks are still owned
 * where expected, the user's own roster stays under the cap) in case
 * anything changed since the offer was generated.
 */
export async function acceptTradeOffer(leagueId: number, offerId: number): Promise<TradeEvaluation> {
  const league = await db.leagues.get(leagueId)
  if (!league || league.userTeamId == null) return { accepted: false, reason: 'League not found' }
  const offer = (league.pendingTradeOffers ?? []).find((o) => o.id === offerId)
  if (!offer) return { accepted: false, reason: 'Offer no longer available' }

  const userTeamId = league.userTeamId
  const rosterUser = await db.players.where('teamId').equals(userTeamId).toArray()
  const rosterAi = await db.players.where('teamId').equals(offer.fromTeamId).toArray()

  const giving = rosterUser.filter((p) => offer.requestPlayerIds.includes(p.id))
  const getting = rosterAi.filter((p) => offer.offerPlayerIds.includes(p.id))
  if (giving.length !== offer.requestPlayerIds.length || getting.length !== offer.offerPlayerIds.length) {
    await removeTradeOffer(leagueId, offerId)
    return { accepted: false, reason: 'This offer is no longer valid - a player already moved' }
  }

  const givePicksResolved = resolvePickRefs(league.tradedPicks, league.season, userTeamId, offer.requestPicks)
  const getPicksResolved = resolvePickRefs(league.tradedPicks, league.season, offer.fromTeamId, offer.offerPicks)
  if (!givePicksResolved.valid || !getPicksResolved.valid) {
    await removeTradeOffer(leagueId, offerId)
    return { accepted: false, reason: 'This offer is no longer valid - a pick already moved' }
  }

  if (!wouldFitUnderCap(rosterUser, offer.requestPlayerIds, getting)) {
    return { accepted: false, reason: 'Would put your team over the salary cap' }
  }

  await executeTradeMechanics(
    leagueId,
    league.tradedPicks,
    rosterUser,
    rosterAi,
    giving,
    getting,
    userTeamId,
    offer.fromTeamId,
    offer.requestPicks,
    offer.offerPicks,
  )
  await removeTradeOffer(leagueId, offerId)

  return { accepted: true, reason: 'Deal accepted' }
}

/** Declines/withdraws a pending offer without executing anything. */
export async function removeTradeOffer(leagueId: number, offerId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) return
  await db.leagues.update(leagueId, {
    pendingTradeOffers: (league.pendingTradeOffers ?? []).filter((o) => o.id !== offerId),
  })
}

/** One player's side of a suggested trade, with enough detail to render a full breakdown without extra fetches. */
export interface SuggestedTradePlayer {
  id: number
  firstName: string
  lastName: string
  position: Position
  age: number
  overall: number
  potential: number
  attr1: number
  attr2: number
  attr3: number
  salary: number
  yearsLeft: number | null
  isStarter: boolean
}

export interface SuggestedTrade {
  otherTeamId: number
  give: SuggestedTradePlayer[]
  get: SuggestedTradePlayer[]
  giveIds: number[]
  getIds: number[]
  givePicks: TradePickRef[]
  reason: string
}

function toSuggestedTradePlayer(p: Player, roster: Player[]): SuggestedTradePlayer {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    position: p.position,
    age: p.age,
    overall: p.ratings.overall,
    potential: p.ratings.potential,
    attr1: p.ratings.attr1,
    attr2: p.ratings.attr2,
    attr3: p.ratings.attr3,
    salary: p.contract?.salary ?? 0,
    yearsLeft: p.contract?.yearsLeft ?? null,
    isStarter: isStarterInRoster(p, roster),
  }
}

/**
 * Tries to find a package of the user's players (1 or 2, cheapest-value
 * first) - optionally with up to 2 owned picks stacked on top as a
 * sweetener - that the AI side (`theirRoster`) would actually accept in
 * exchange for `getSet`. Returns the smallest package that works, or null
 * if nothing tried gets there. This is what lets a suggestion be "2 of your
 * depth guys" or "1 guy + a pick" instead of always exactly one-for-one.
 */
function tryGivePackage(
  theirRoster: Player[],
  getSet: Player[],
  give: Player[],
  myRoster: Player[],
  picksAvailable: TradePickRef[],
  season: number,
): { give: Player[]; picks: TradePickRef[] } | null {
  if (!wouldFitUnderCap(myRoster, give.map((p) => p.id), getSet)) return null
  if (evaluateTrade(theirRoster, getSet, give).accepted) return { give, picks: [] }

  let picks: TradePickRef[] = []
  let sweetenerValue = 0
  for (const pick of picksAvailable) {
    sweetenerValue += pickValue(pick.round, pick.year - season)
    picks = [...picks, pick]
    if (evaluateTrade(theirRoster, getSet, give, 0, sweetenerValue).accepted) return { give, picks }
    if (picks.length >= 2) break // don't sweeten with more than 2 picks
  }
  return null
}

function findAcceptablePackage(
  theirRoster: Player[],
  getSet: Player[],
  giveCandidates: Player[],
  myRoster: Player[],
  picksAvailable: TradePickRef[],
  season: number,
): { give: Player[]; picks: TradePickRef[] } | null {
  // Singles: try every surplus player, cheapest-value first, so a modest
  // depth piece is preferred whenever it's actually enough on its own -
  // no cap here, a roster is small enough that this is cheap.
  for (const g of giveCandidates) {
    const result = tryGivePackage(theirRoster, getSet, [g], myRoster, picksAvailable, season)
    if (result) return result
  }

  // Pairs: a single surplus piece alone often isn't enough for a real
  // upgrade target, so this is where most matches actually get found -
  // capped to a generous pool (not just the very cheapest) so a
  // high-value target still has a shot at a package that reaches it.
  const pool = giveCandidates.slice(0, 25)
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const result = tryGivePackage(theirRoster, getSet, [pool[i], pool[j]], myRoster, picksAvailable, season)
      if (result) return result
    }
  }
  return null
}

/**
 * Scans every AI team's roster for a deal that would genuinely upgrade the
 * user's team (fills a need or clearly beats their current starter at that
 * spot) and that the AI side would actually say yes to (runs the same
 * evaluateTrade fairness check proposeTrade uses, from the AI's own side -
 * it never suggests a deal the AI wouldn't take). Meant to surface as a
 * one-click "Make this trade" list, not something the user has to hunt for
 * manually. Capped at a couple of suggestions per opposing team so the list
 * reads as offers from across the league, not just whichever team happens
 * to come first with a deep bench.
 *
 * Packages aren't limited to one-for-one: findAcceptablePackage tries 1 or
 * 2 of the user's own players, optionally with up to 2 owned picks stacked
 * on as a sweetener, and if even that isn't enough for a single target, a
 * second (lesser) target from the same team gets bundled in too - a real
 * "throw in a guy to make the numbers work" style package.
 *
 * `seed` shuffles which teams/candidates get looked at first, so calling
 * this again with a different seed (a "refresh" in the UI) surfaces a
 * different slice of the league instead of the exact same list every time.
 */
export async function findSuggestedTrades(leagueId: number, limit = 5, seed = 0): Promise<SuggestedTrade[]> {
  const league = await db.leagues.get(leagueId)
  if (!league || league.userTeamId == null) return []

  const rng = createRng(seed + 1)
  const teams = shuffle(await db.teams.toArray(), rng)
  const allTeamIds = teams.map((t) => t.id)
  const myRoster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  const myNeeds = new Set(rosterNeeds(myRoster))
  const myByPosition = new Map<Position, Player[]>()
  for (const p of myRoster) {
    const list = myByPosition.get(p.position) ?? []
    list.push(p)
    myByPosition.set(p.position, list)
  }
  const wouldUpgradeMe = (p: Player) => {
    const myBest = (myByPosition.get(p.position) ?? []).sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
    return myNeeds.has(p.position) || !myBest || p.ratings.overall > myBest.ratings.overall + 4
  }
  const myBestAt = (pos: Position) => (myByPosition.get(pos) ?? []).sort((a, b) => b.ratings.overall - a.ratings.overall)[0]

  const allMyPicks = [...ownedPicks(league.tradedPicks, league.season, allTeamIds, league.userTeamId, 5)].sort(
    (a, b) => pickValue(a.round, a.year - league.season) - pickValue(b.round, b.year - league.season),
  )
  const usedGiveIds = new Set<number>()
  const usedPickKeys = new Set<string>()
  const pickKey = (r: TradePickRef) => `${r.year}-${r.round}-${r.originalTeamId}`

  const maxPerTeam = 2
  const suggestions: SuggestedTrade[] = []
  for (const team of teams) {
    if (team.id === league.userTeamId) continue
    if (suggestions.length >= limit) break

    const theirRoster = await db.players.where('teamId').equals(team.id).toArray()
    const theirNeeds = new Set(rosterNeeds(theirRoster))
    let addedForTeam = 0

    const theirCandidates = shuffle(
      [...theirRoster].sort((a, b) => b.ratings.overall - a.ratings.overall).slice(0, 15),
      rng,
    )
    const usedTheirIds = new Set<number>()

    for (const theirs of theirCandidates) {
      if (suggestions.length >= limit || addedForTeam >= maxPerTeam) break
      if (usedTheirIds.has(theirs.id)) continue
      if (!wouldUpgradeMe(theirs)) continue
      // Skip deals the AI would take but that would leave them thin at a
      // position they actually need - not realistic even if "fair" by value.
      if (theirNeeds.has(theirs.position)) continue

      const myBest = myBestAt(theirs.position)

      // Offer from my own surplus - positions I'm not short on, cheapest
      // players first so the ask stays modest - skipping anything I'd need
      // more than I need the upgrade itself, and anything already promised
      // to an earlier suggestion in this same list.
      const mySurplus = myRoster
        .filter((p) => p.id !== myBest?.id && !myNeeds.has(p.position) && !usedGiveIds.has(p.id))
        .sort((a, b) => playerValue(a) - playerValue(b))
      const picksAvailable = allMyPicks.filter((r) => !usedPickKeys.has(pickKey(r)))

      let getSet = [theirs]
      let result = findAcceptablePackage(theirRoster, getSet, mySurplus, myRoster, picksAvailable, league.season)

      let bundledSecond: Player | null = null
      if (!result) {
        // A single-target package didn't work - see if bundling a second,
        // lesser target from the same team (also an upgrade, also not
        // needed by them) makes the numbers work as a 2-for-something deal.
        bundledSecond =
          theirCandidates.find(
            (c) =>
              c.id !== theirs.id &&
              !usedTheirIds.has(c.id) &&
              !theirNeeds.has(c.position) &&
              wouldUpgradeMe(c),
          ) ?? null
        if (bundledSecond) {
          getSet = [theirs, bundledSecond]
          result = findAcceptablePackage(theirRoster, getSet, mySurplus, myRoster, picksAvailable, league.season)
        }
      }

      if (!result) continue

      const reasonFor = (p: Player) => {
        const best = myBestAt(p.position)
        return myNeeds.has(p.position)
          ? `Fills your need at ${p.position}`
          : `Upgrade at ${p.position} (${p.ratings.overall} OVR vs your ${best?.ratings.overall ?? 0})`
      }

      suggestions.push({
        otherTeamId: team.id,
        give: result.give.map((p) => toSuggestedTradePlayer(p, myRoster)),
        get: getSet.map((p) => toSuggestedTradePlayer(p, theirRoster)),
        giveIds: result.give.map((p) => p.id),
        getIds: getSet.map((p) => p.id),
        givePicks: result.picks,
        reason:
          [reasonFor(theirs), bundledSecond ? reasonFor(bundledSecond) : null].filter(Boolean).join(' + ') +
          (result.picks.length > 0 ? ` · needs ${result.picks.length > 1 ? 'picks' : 'a pick'} added to close the gap` : ''),
      })
      result.give.forEach((p) => usedGiveIds.add(p.id))
      result.picks.forEach((r) => usedPickKeys.add(pickKey(r)))
      getSet.forEach((p) => usedTheirIds.add(p.id))
      addedForTeam++
    }
  }

  return suggestions
}

/** Deterministic Fisher-Yates shuffle - used to vary which teams/candidates findSuggestedTrades looks at on a "refresh". */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export interface SeasonHistoryEntry {
  season: number
  champTeamId: number
  runnerUpTeamId: number
  champScore: number
  runnerUpScore: number
}

/**
 * Derived entirely from stored games - no separate history table needed.
 * Every completed season leaves exactly one 'superbowl' game behind, which
 * is enough to reconstruct who won it and who they beat.
 */
export async function getSeasonHistory(leagueId: number): Promise<SeasonHistoryEntry[]> {
  const superbowls = await db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.round === 'superbowl')
    .toArray()

  return superbowls
    .map((g) => {
      const champTeamId = winnerOf(g)
      const runnerUpTeamId = champTeamId === g.homeTeamId ? g.awayTeamId : g.homeTeamId
      const champScore = champTeamId === g.homeTeamId ? g.homeScore : g.awayScore
      const runnerUpScore = champTeamId === g.homeTeamId ? g.awayScore : g.homeScore
      return { season: g.season, champTeamId, runnerUpTeamId, champScore, runnerUpScore }
    })
    .sort((a, b) => b.season - a.season)
}
