import { db } from '../db'
import type { Player } from '../types'
import { runDraft } from './draft'
import { simGame } from './gameSim'
import { generateRosterForTeam } from './players'
import { ageAndRetire } from './retirement'
import { createRng } from './rng'
import { generateSchedule, type ScheduledGame } from './schedule'
import { computeStandings } from './standings'
import { generateTeams } from './teams'

export async function createLeague(name: string, userTeamIndex: number, seed = Date.now()) {
  const rng = createRng(seed)

  const leagueId = await db.leagues.add({
    id: 0,
    name,
    season: new Date().getFullYear(),
    week: 1,
    phase: 'regular',
    champTeamId: null,
    userTeamId: null,
    createdAt: Date.now(),
  } as never)

  const teamDrafts = generateTeams()
  const teamIds: number[] = []
  for (const team of teamDrafts) {
    const id = await db.teams.add(team as never)
    teamIds.push(id)
  }

  for (const teamId of teamIds) {
    const roster = generateRosterForTeam(rng, teamId)
    await db.players.bulkAdd(roster as never[])
  }

  const userTeamId = teamIds[userTeamIndex] ?? teamIds[0]
  await db.leagues.update(leagueId as number, { userTeamId })

  await generateAndStoreSchedule(leagueId as number, teamIds, new Date().getFullYear())

  return leagueId as number
}

async function generateAndStoreSchedule(leagueId: number, teamIds: number[], season: number) {
  const schedule: ScheduledGame[] = generateSchedule(teamIds)
  await db.schedule.bulkAdd(
    schedule.map((g) => ({ leagueId, season, ...g })) as never[],
  )
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

export function regularSeasonWeeks(teamCount: number) {
  return teamCount - 1
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

  const teams = await db.teams.toArray()
  const nextWeek = league.week + 1
  const isRegularSeasonOver = nextWeek > regularSeasonWeeks(teams.length)
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

async function simPlayoffRound(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

  const teams = await db.teams.toArray()
  const rng = createRng(league.season * 1000 + 900 + league.week)

  const semis = await db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.season === league.season && g.round === 'semifinal')
    .toArray()
  const final = await db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.season === league.season && g.round === 'final')
    .toArray()

  if (semis.length === 0) {
    const regularGames = await currentSeasonRegularGames(leagueId, league.season)
    const standings = computeStandings(teams, regularGames)
    const [s1, s2, s3, s4] = standings

    const matchups = [
      { home: s1.teamId, away: s4.teamId },
      { home: s2.teamId, away: s3.teamId },
    ]

    for (const m of matchups) {
      const homeRoster = await db.players.where('teamId').equals(m.home).toArray()
      const awayRoster = await db.players.where('teamId').equals(m.away).toArray()
      const result = simGame(rng, homeRoster, awayRoster)
      await db.games.add({
        leagueId,
        season: league.season,
        week: league.week,
        homeTeamId: m.home,
        awayTeamId: m.away,
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        round: 'semifinal',
      } as never)
    }

    await db.leagues.update(leagueId, { week: league.week + 1 })
    return
  }

  if (final.length === 0) {
    const winners = semis.map((g) => (g.homeScore >= g.awayScore ? g.homeTeamId : g.awayTeamId))
    const [home, away] = winners

    const homeRoster = await db.players.where('teamId').equals(home).toArray()
    const awayRoster = await db.players.where('teamId').equals(away).toArray()
    const result = simGame(rng, homeRoster, awayRoster)
    await db.games.add({
      leagueId,
      season: league.season,
      week: league.week,
      homeTeamId: home,
      awayTeamId: away,
      homeScore: result.homeScore,
      awayScore: result.awayScore,
      round: 'final',
    } as never)

    const champTeamId = result.homeScore >= result.awayScore ? home : away
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
  if (retiredIds.length > 0) await db.players.bulkDelete(retiredIds)
  await db.players.bulkPut(agedPlayers as never[])

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
  await generateAndStoreSchedule(
    leagueId,
    teams.map((t) => t.id),
    nextSeason,
  )

  await db.leagues.update(leagueId, {
    season: nextSeason,
    week: 1,
    phase: 'regular',
    champTeamId: null,
  })

  return { retiredCount: retiredIds.length, draftedCount: picks.length }
}
