import Dexie, { type EntityTable } from 'dexie'
import type { GameResult, League, Player, PlayerGameStats, ScheduledGame, Team } from '../types'

export class DynastyDB extends Dexie {
  leagues!: EntityTable<League, 'id'>
  teams!: EntityTable<Team, 'id'>
  players!: EntityTable<Player, 'id'>
  games!: EntityTable<GameResult, 'id'>
  schedule!: EntityTable<ScheduledGame, 'id'>
  playerGameStats!: EntityTable<PlayerGameStats, 'id'>

  constructor() {
    super('dynasty')
    this.version(1).stores({
      leagues: '++id, name',
      teams: '++id, abbrev',
      players: '++id, teamId, position',
      games: '++id, leagueId, season, week, homeTeamId, awayTeamId',
      schedule: '++id, leagueId, season, week',
    })
    this.version(2).stores({
      // Keep indexes minimal: every index adds maintenance cost on every
      // insert/delete, and a season's worth of box scores is ~8k rows.
      // [leagueId+season] covers "this season's stats" (the only bulk
      // query), playerId covers "one player's career stats"; week/gameId/
      // teamId are filtered in memory from the season's rows instead.
      playerGameStats: '++id, [leagueId+season], playerId',
    })
  }
}

export const db = new DynastyDB()
