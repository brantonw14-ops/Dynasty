import Dexie, { type EntityTable } from 'dexie'
import type { GameResult, League, Player, ScheduledGame, Team } from '../types'

export class DynastyDB extends Dexie {
  leagues!: EntityTable<League, 'id'>
  teams!: EntityTable<Team, 'id'>
  players!: EntityTable<Player, 'id'>
  games!: EntityTable<GameResult, 'id'>
  schedule!: EntityTable<ScheduledGame, 'id'>

  constructor() {
    super('dynasty')
    this.version(1).stores({
      leagues: '++id, name',
      teams: '++id, abbrev',
      players: '++id, teamId, position',
      games: '++id, leagueId, season, week, homeTeamId, awayTeamId',
      schedule: '++id, leagueId, season, week',
    })
  }
}

export const db = new DynastyDB()
