import { db } from '../db'
import type { Conference, GameResult, Player, PlayoffRound, Team } from '../types'
import { runDraft } from './draft'
import { computeCapSpace, expireContracts, runFreeAgency } from './freeAgency'
import { simGame } from './gameSim'
import { generateRosterForTeam, rosterNeeds } from './players'
import { progressPlayer } from './progression'
import { ageAndRetire } from './retirement'
import { createRng } from './rng'
import { generateSchedule } from './schedule'
import { computeConferenceSeeds, computeStandings, type PlayoffSeed } from './standings'
import { generateTeams } from './teams'

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
  await db.transaction('rw', db.leagues, db.teams, db.players, db.games, db.schedule, async () => {
    const teams = await db.teams.toArray()
    await db.players.where('teamId').anyOf(teams.map((t) => t.id)).delete()
    await db.teams.bulkDelete(teams.map((t) => t.id))
    await db.games.where({ leagueId }).delete()
    await db.schedule.where({ leagueId }).delete()
    await db.leagues.delete(leagueId)
  })
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
    await db.games.add({
      leagueId,
      season: league.season,
      week: league.week,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: result.homeScore,
      awayScore: result.awayScore,
    } as never)
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
  await db.games.add({
    leagueId,
    season,
    week,
    homeTeamId,
    awayTeamId,
    homeScore: result.homeScore,
    awayScore: result.awayScore,
    round,
  } as never)
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
