import { db } from '../db'
import type { Player } from '../types'
import { simGame } from './gameSim'
import { generatePlayer } from './players'
import { createRng } from './rng'
import { generateSchedule, type ScheduledGame } from './schedule'
import { computeStandings } from './standings'
import { generateTeams } from './teams'

export async function createLeague(name: string, seed = Date.now()) {
  const rng = createRng(seed)

  const leagueId = await db.leagues.add({
    id: 0,
    name,
    season: new Date().getFullYear(),
    week: 1,
    phase: 'regular',
    champTeamId: null,
    createdAt: Date.now(),
  } as never)

  const teamDrafts = generateTeams()
  const teamIds: number[] = []
  for (const team of teamDrafts) {
    const id = await db.teams.add(team as never)
    teamIds.push(id)
  }

  for (const teamId of teamIds) {
    const roster: Player[] = []
    const positions: Array<Player['position']> = [
      'QB', 'QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'WR', 'WR',
      'TE', 'TE', 'TE', 'OL', 'OL', 'OL', 'OL', 'OL', 'OL', 'OL', 'OL', 'OL',
      'DL', 'DL', 'DL', 'DL', 'DL', 'DL', 'DL', 'DL', 'LB', 'LB', 'LB', 'LB', 'LB', 'LB', 'LB',
      'CB', 'CB', 'CB', 'CB', 'CB', 'CB', 'S', 'S', 'S', 'S', 'K', 'P',
    ]
    for (const pos of positions) {
      const p = generatePlayer(rng, pos, teamId)
      roster.push(p as Player)
    }
    await db.players.bulkAdd(roster as never[])
  }

  const schedule: ScheduledGame[] = generateSchedule(teamIds)
  const season = new Date().getFullYear()
  await db.schedule.bulkAdd(
    schedule.map((g) => ({ leagueId: leagueId as number, season, ...g })) as never[],
  )

  return leagueId as number
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

  const weekGames = await db.schedule.where({ leagueId, week: league.week }).toArray()
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

async function simPlayoffRound(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

  const teams = await db.teams.toArray()
  const rng = createRng(league.season * 1000 + 900 + league.week)

  const semis = await db.games.where({ leagueId, round: 'semifinal' }).toArray()
  const final = await db.games.where({ leagueId, round: 'final' }).toArray()

  if (semis.length === 0) {
    const regularGames = await db.games
      .where('leagueId')
      .equals(leagueId)
      .and((g) => g.round === undefined)
      .toArray()
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
