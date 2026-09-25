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

export type Conference = 'AFC' | 'NFC'
export type Division = 'East' | 'North' | 'South' | 'West'

export interface Team {
  id: number
  region: string
  name: string
  abbrev: string
  colors: [string, string]
  conference: Conference
  division: Division
  capSpace: number
}

export type PlayoffRound = 'wildcard' | 'divisional' | 'conference' | 'superbowl'

export interface GameResult {
  id: number
  leagueId: number
  season: number
  week: number
  homeTeamId: number
  awayTeamId: number
  homeScore: number
  awayScore: number
  round?: PlayoffRound
}

export interface ScheduledGame {
  id: number
  leagueId: number
  season: number
  week: number
  homeTeamId: number
  awayTeamId: number
}

export type LeaguePhase = 'regular' | 'playoffs' | 'complete'

export interface League {
  id: number
  name: string
  season: number
  week: number
  regularSeasonWeeks: number
  phase: LeaguePhase
  champTeamId: number | null
  userTeamId: number | null
  createdAt: number
}
