import { db } from '../db'
import type { Player } from '../types'
import { simGame } from './gameSim'
import { generatePlayer } from './players'
import { createRng } from './rng'
import { generateSchedule, type ScheduledGame } from './schedule'
import { generateTeams } from './teams'

export async function createLeague(name: string, seed = Date.now()) {
  const rng = createRng(seed)

  const leagueId = await db.leagues.add({
    id: 0,
    name,
    season: new Date().getFullYear(),
    week: 1,
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

export async function simWeek(leagueId: number) {
  const league = await db.leagues.get(leagueId)
  if (!league) throw new Error('League not found')

  const weekGames = await db.schedule
    .where({ leagueId, week: league.week })
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

  await db.leagues.update(leagueId, { week: league.week + 1 })
}
