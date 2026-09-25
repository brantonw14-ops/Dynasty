import { db } from '../db'
import type { Conference, GameResult, Player, PlayoffRound, Team } from '../types'
import { runDraft } from './draft'
import { simGame } from './gameSim'
import { generateRosterForTeam } from './players'
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

/**
 * Offseason: ages every player a year (with retirements), then runs a
 * worst-record-picks-first draft to refill each team back to a full roster,
 * and rolls the league into a fresh regular season.
 */
export async function advanceToNextSeason(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')
  if (league.phase !== 'complete') throw new Error('Season is not finished yet')

  const rng = createRng(league.season * 7919 + 1)
  const teams = await db.teams.toArray()
  const allPlayers = await db.players.toArray()

  const { retiredIds, agedPlayers } = ageAndRetire(rng, allPlayers)
  const progressedPlayers = agedPlayers.map((p) => progressPlayer(rng, p))
  if (retiredIds.length > 0) await db.players.bulkDelete(retiredIds)
  await db.players.bulkPut(progressedPlayers as never[])

  const rostersByTeam = new Map<number, Player[]>()
  for (const team of teams) {
    rostersByTeam.set(
      team.id,
      agedPlayers.filter((p) => p.teamId === team.id),
    )
  }

  const regularGames = await currentSeasonRegularGames(leagueId, league.season)
  const standings = computeStandings(teams, regularGames)
  const draftOrderTeamIds = [...standings].reverse().map((s) => s.teamId)

  const picks = runDraft(rng, teams, rostersByTeam, draftOrderTeamIds)
  if (picks.length > 0) {
    await db.players.bulkAdd(picks.map((p) => p.player) as never[])
  }

  const nextSeason = league.season + 1
  const regularSeasonWeeks = await generateAndStoreSchedule(leagueId, teams, nextSeason, rng)

  await db.leagues.update(leagueId, {
    season: nextSeason,
    week: 1,
    regularSeasonWeeks,
    phase: 'regular',
    champTeamId: null,
  })

  return { retiredCount: retiredIds.length, draftedCount: picks.length }
}
