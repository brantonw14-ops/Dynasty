export type Position =
  | 'QB'
  | 'RB'
  | 'WR'
  | 'TE'
  | 'OL'
  | 'DL'
  | 'LB'
  | 'CB'
  | 'S'
  | 'K'
  | 'P'

export interface Ratings {
  overall: number
  speed: number
  strength: number
  agility: number
  awareness: number
  potential: number
}

export interface Contract {
  salary: number
  yearsLeft: number
}

export interface Player {
  id: number
  firstName: string
  lastName: string
  age: number
  position: Position
  teamId: number | null // null = free agent
  ratings: Ratings
  contract: Contract | null
  retired: boolean
}

export interface Team {
  id: number
  region: string
  name: string
  abbrev: string
  colors: [string, string]
  capSpace: number
}

export interface GameResult {
  id: number
  leagueId: number
  season: number
  week: number
  homeTeamId: number
  awayTeamId: number
  homeScore: number
  awayScore: number
}

export interface ScheduledGame {
  id: number
  leagueId: number
  season: number
  week: number
  homeTeamId: number
  awayTeamId: number
}

export interface League {
  id: number
  name: string
  season: number
  week: number
  createdAt: number
}
