import { db } from '../db'
import type { Conference, DraftPickLogEntry, Division, GameResult, Player, PlayoffRound, Position, Team } from '../types'
import { generateDraftClass, prospectToPlayer, type CollegeProspect } from './draft'
import { computeCapSpace, expireContractsWithAiRetention, runFreeAgency } from './freeAgency'
import { simGame, type PlayerBoxScore } from './gameSim'
import { applyGamePerformance } from './inSeasonProgression'
import { advanceInjuries, rollNewInjuries } from './injuries'
import { classifyTeamOutlook, generateRosterForTeam, nextDepthOrder, rosterNeeds, type TeamOutlook } from './players'
import { progressPlayer } from './progression'
import { ageAndRetire } from './retirement'
import { createRng } from './rng'
import { marketSalary } from './salary'
import { generateSchedule } from './schedule'
import { adjustPotentialForSeason } from './seasonPerformance'
import { computeConferenceSeeds, computeStandings, type PlayoffSeed } from './standings'
import { generateTeams, SALARY_CAP } from './teams'
import { evaluateTrade, type TradeEvaluation } from './trades'

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

  const nextWeek = league.week + 1
  const isRegularSeasonOver = nextWeek > league.regularSeasonWeeks
  await db.leagues.update(leagueId, {
    week: nextWeek,
    phase: isRegularSeasonOver ? 'playoffs' : 'regular',
  })
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

export async function simWeek(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

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

/**
 * Offseason step 2: closes the user's free agency window by running AI
 * free agency (every team except the user's, signing from whatever's left
 * in the pool), then sets up an interactive rookie draft - worst record
 * picks first, same order every round. The prospect pool itself is never
 * persisted (regenerated on demand from draftSeed); only which prospects
 * are taken and whose turn it is lives on the league row. Auto-advances
 * through any AI-only picks immediately so the draft screen opens right on
 * the user's first turn (or fully resolves and rolls into the regular
 * season if the user has no team).
 */
export async function beginDraft(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'freeagency') throw new Error('Not in the free agency window')

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

  // The draft class's positions are fixed at the moment the draft opens -
  // one prospect per currently-open roster spot, league-wide.
  const draftPositions: Position[] = []
  for (const team of teams) {
    draftPositions.push(...rosterNeeds(rostersByTeam.get(team.id) ?? []))
  }

  await db.leagues.update(leagueId, {
    phase: 'draft',
    draftSeed: league.season * 7919 + 3,
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
  log: DraftPickLogEntry[]
}

export async function getDraftBoard(leagueId: number): Promise<DraftBoardState | null> {
  const league = await db.leagues.get(leagueId)
  if (!league || league.phase !== 'draft' || !league.draftPositions || !league.draftOrderTeamIds) return null

  const prospects = generateDraftClass(league.draftSeed ?? 0, league.draftPositions)
  const pickedIndices = new Set(league.draftPickedIndices ?? [])
  const order = league.draftOrderTeamIds
  const orderIndex = league.draftOrderIndex ?? 0
  const currentTeamId = order.length > 0 ? order[orderIndex % order.length] : null

  return {
    prospects,
    pickedIndices,
    currentTeamId,
    isUserTurn: currentTeamId != null && currentTeamId === league.userTeamId,
    pickNumber: (league.draftLog?.length ?? 0) + 1,
    totalPicks: prospects.length,
    log: league.draftLog ?? [],
  }
}

/**
 * Auto-picks for every AI team's turn (best available prospect at a
 * position they still need), stopping either at the user's next turn or
 * once the draft is fully resolved (rolling straight into the regular
 * season in that case). `stopBeforeUserTurn: false` runs the whole
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
  let consecutiveSkips = 0

  while (picked.size < prospects.length && consecutiveSkips < order.length) {
    const teamId = order[orderIndex % order.length]
    if (stopBeforeUserTurn && teamId === league.userTeamId) break

    const roster = await db.players.where('teamId').equals(teamId).toArray()
    const needs = rosterNeeds(roster)
    if (needs.length === 0) {
      orderIndex++
      consecutiveSkips++
      continue
    }

    const best = prospects
      .filter((p) => !picked.has(p.index) && needs.includes(p.position))
      .sort((a, b) => b.ratings.overall - a.ratings.overall)[0]

    if (!best) {
      orderIndex++
      consecutiveSkips++
      continue
    }

    const depthOrder = nextDepthOrder(roster, best.position)
    await db.players.add(prospectToPlayer(best, teamId, depthOrder) as never)
    picked.add(best.index)
    log.push({ pickNumber: log.length + 1, teamId, prospectIndex: best.index })
    orderIndex++
    consecutiveSkips = 0
  }

  await db.leagues.update(leagueId, {
    draftOrderIndex: orderIndex,
    draftPickedIndices: [...picked],
    draftLog: log,
  })

  const draftIsDone =
    picked.size >= prospects.length ||
    consecutiveSkips >= order.length ||
    (await allTeamsRosterFull(order))
  if (draftIsDone) {
    await finalizeDraft(leagueId)
  }
}

async function allTeamsRosterFull(teamIds: number[]) {
  for (const teamId of teamIds) {
    const roster = await db.players.where('teamId').equals(teamId).toArray()
    if (rosterNeeds(roster).length > 0) return false
  }
  return true
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
  const currentTeamId = order[orderIndex % order.length]
  if (currentTeamId !== league.userTeamId) throw new Error("It's not your turn to pick")

  const picked = new Set(league.draftPickedIndices ?? [])
  if (picked.has(prospectIndex)) throw new Error('That prospect has already been drafted')

  const prospects = generateDraftClass(league.draftSeed ?? 0, league.draftPositions)
  const prospect = prospects[prospectIndex]
  if (!prospect) throw new Error('Invalid prospect')

  const roster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  if (!rosterNeeds(roster).includes(prospect.position)) {
    throw new Error(`Your roster doesn't need another ${prospect.position} right now`)
  }

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

/**
 * Proposes a trade: teamA sends `giveIds` and receives `getIds` from teamB.
 * teamB (typically an AI team) evaluates it from their own side; if
 * accepted, the trade executes immediately. Also blocks the deal if it
 * would put teamA over the salary cap - teamB's own roster-need and cap
 * checks happen inside evaluateTrade.
 */
export async function proposeTrade(
  teamAId: number,
  teamBId: number,
  giveIds: number[],
  getIds: number[],
): Promise<TradeEvaluation> {
  const rosterA = await db.players.where('teamId').equals(teamAId).toArray()
  const rosterB = await db.players.where('teamId').equals(teamBId).toArray()

  const giving = rosterA.filter((p) => giveIds.includes(p.id))
  const getting = rosterB.filter((p) => getIds.includes(p.id))
  if (giving.length !== giveIds.length || getting.length !== getIds.length) {
    return { accepted: false, reason: 'Invalid player selection' }
  }

  const evaluation = evaluateTrade(rosterB, getting, giving)
  if (!evaluation.accepted) return evaluation

  const givingIds = new Set(giveIds)
  const resultingA = [...rosterA.filter((p) => !givingIds.has(p.id)), ...getting]
  const capUsedA = resultingA.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
  if (capUsedA > SALARY_CAP) {
    return { accepted: false, reason: 'Would put your team over the salary cap' }
  }

  await db.players.bulkPut(
    giving.map((p) => ({ ...p, teamId: teamBId, depthOrder: nextDepthOrder(rosterB, p.position) })) as never[],
  )
  await db.players.bulkPut(
    getting.map((p) => ({ ...p, teamId: teamAId, depthOrder: nextDepthOrder(rosterA, p.position) })) as never[],
  )

  return evaluation
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
