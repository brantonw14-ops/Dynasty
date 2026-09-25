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

/**
 * Overall is derived solely from a player's three position-specific core
 * attributes (attr1/attr2/attr3) - what those three actually mean depends
 * on position, see POSITION_ATTRIBUTES in engine/players.ts (e.g. for a WR
 * they're Speed/Catching/Route Running; for a K, Kick Accuracy/Kick Power/
 * Clutch Gene).
 */
export interface Ratings {
  overall: number
  potential: number
  attr1: number
  attr2: number
  attr3: number
}

export interface Contract {
  salary: number
  yearsLeft: number
}

export interface Injury {
  weeksRemaining: number
  description: string
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
  injury: Injury | null
  // Depth-chart rank within this player's position on their current team
  // (0 = starter). Defaults to an overall-based rank at generation time,
  // but the user can freely reorder their own team's depth chart.
  depthOrder: number
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

export interface PlayerGameStats {
  id: number
  leagueId: number
  season: number
  week: number
  gameId: number
  teamId: number
  playerId: number
  position: Position
  passYards: number
  passTDs: number
  passAttempts: number
  passCompletions: number
  interceptions: number
  rushYards: number
  rushTDs: number
  recYards: number
  recTDs: number
  receptions: number
  tackles: number
  sacks: number
  tacklesForLoss: number
  passBreakups: number
  defInterceptions: number
  yardsAllowed: number
  passerRatingAllowed: number
  pancakes: number
  sacksAllowed: number
  tflsAllowed: number
  fieldGoalsMade: number
  fieldGoalsAttempted: number
  longestFieldGoal: number
  extraPointsMade: number
  extraPointsAttempted: number
  puntCount: number
  puntYards: number
}

export interface ScheduledGame {
  id: number
  leagueId: number
  season: number
  week: number
  homeTeamId: number
  awayTeamId: number
}

export type LeaguePhase = 'regular' | 'playoffs' | 'complete' | 'resign' | 'freeagency'

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
