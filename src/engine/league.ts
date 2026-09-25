import { db } from '../db'
import type { Conference, Division, GameResult, Player, PlayoffRound, Team } from '../types'
import { runDraft } from './draft'
import { computeCapSpace, expireContracts, runFreeAgency } from './freeAgency'
import { simGame, type PlayerBoxScore } from './gameSim'
import { classifyTeamOutlook, generateRosterForTeam, rosterNeeds, type TeamOutlook } from './players'
import { progressPlayer } from './progression'
import { ageAndRetire } from './retirement'
import { createRng } from './rng'
import { generateSchedule } from './schedule'
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
    rushYards: b.rushYards,
    rushTDs: b.rushTDs,
    recYards: b.recYards,
    recTDs: b.recTDs,
    receptions: b.receptions,
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

  for (const g of weekGames) {
    const homeRoster = await db.players.where('teamId').equals(g.homeTeamId).toArray()
    const awayRoster = await db.players.where('teamId').equals(g.awayTeamId).toArray()
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
  const homeRoster = await db.players.where('teamId').equals(homeTeamId).toArray()
  const awayRoster = await db.players.where('teamId').equals(awayTeamId).toArray()
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
 * progression) and lets contracts expire into free agency, then pauses the
 * league in the 'freeagency' phase. AI teams deliberately do NOT sign
 * anyone yet - the user gets an uncontested shopping window here; AI
 * signing only happens once they click through to the draft (proceedToDraft),
 * so the whole pool isn't gone before they ever see the free agent list.
 */
export async function advanceToFreeAgency(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'complete') throw new Error('Season is not finished yet')

  const rng = createRng(league.season * 7919 + 1)
  const allPlayers = await db.players.toArray()

  const { retiredIds, agedPlayers } = ageAndRetire(rng, allPlayers)
  const progressedPlayers = agedPlayers.map((p) => progressPlayer(rng, p))
  const expiredPlayers = expireContracts(progressedPlayers)
  if (retiredIds.length > 0) await db.players.bulkDelete(retiredIds)
  await db.players.bulkPut(expiredPlayers as never[])

  const freeAgentCount = expiredPlayers.filter((p) => p.teamId === null).length

  const nextSeason = league.season + 1
  await db.leagues.update(leagueId, {
    season: nextSeason,
    phase: 'freeagency',
    champTeamId: null,
  })

  return { retiredCount: retiredIds.length, freeAgentCount }
}

/** Signs an available free agent to the user's team during the free agency window. */
export async function signFreeAgent(leagueId: number, playerId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'freeagency') throw new Error('Not in the free agency window')
  if (league.userTeamId == null) throw new Error('League has no user team')

  const player = await db.players.get(playerId)
  if (!player || player.teamId !== null) throw new Error('Player is not a free agent')

  const roster = await db.players.where('teamId').equals(league.userTeamId).toArray()
  if (!rosterNeeds(roster).includes(player.position)) {
    throw new Error(`Roster already full at ${player.position}`)
  }

  const capSpace = computeCapSpace(roster)
  const rng = createRng(league.season * 7919 + playerId)
  const salary = Math.round((500_000 + Math.max(0, player.ratings.overall - 50) * 250_000) * (0.85 + rng() * 0.3))
  if (salary > capSpace) throw new Error('Not enough cap space to sign this player')

  await db.players.update(playerId, {
    teamId: league.userTeamId,
    contract: { salary, yearsLeft: 1 + Math.floor(rng() * 3) },
  })
}

/**
 * Offseason step 2: closes the user's free agency window by running AI
 * free agency (every team except the user's, signing from whatever's left
 * in the pool), then the rookie draft to fill every team's remaining needs
 * (including the user's), generates the new season's schedule, and starts
 * the regular season.
 */
export async function proceedToDraft(leagueId: number) {
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
  const signings = runFreeAgency(
    rng,
    teams,
    rostersByTeam,
    freeAgents,
    draftOrderTeamIds,
    excludeTeamIds,
  )
  if (signings.length > 0) {
    await db.players.bulkPut(signings.map((s) => s.player) as never[])
    for (const s of signings) {
      rostersByTeam.get(s.teamId)?.push(s.player as Player)
    }
  }

  const picks = runDraft(rng, teams, rostersByTeam, draftOrderTeamIds)
  if (picks.length > 0) {
    await db.players.bulkAdd(picks.map((p) => p.player) as never[])
  }

  const regularSeasonWeeks = await generateAndStoreSchedule(leagueId, teams, league.season, rng)

  await db.leagues.update(leagueId, {
    week: 1,
    regularSeasonWeeks,
    phase: 'regular',
  })

  return { draftedCount: picks.length }
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

  await db.players.bulkPut(giving.map((p) => ({ ...p, teamId: teamBId })) as never[])
  await db.players.bulkPut(getting.map((p) => ({ ...p, teamId: teamAId })) as never[])

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
