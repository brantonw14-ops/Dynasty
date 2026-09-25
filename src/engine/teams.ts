import type { Conference, Division, Team } from '../types'

type TeamSeed = Pick<Team, 'region' | 'name' | 'abbrev' | 'colors' | 'conference' | 'division'>

const TEAM_SEED: TeamSeed[] = [
  // AFC East
  { region: 'Buffalo', name: 'Bills', abbrev: 'BUF', colors: ['#00338d', '#c60c30'], conference: 'AFC', division: 'East' },
  { region: 'Miami', name: 'Dolphins', abbrev: 'MIA', colors: ['#008e97', '#fc4c02'], conference: 'AFC', division: 'East' },
  { region: 'New England', name: 'Patriots', abbrev: 'NE', colors: ['#002244', '#c60c30'], conference: 'AFC', division: 'East' },
  { region: 'New York', name: 'Jets', abbrev: 'NYJ', colors: ['#125740', '#ffffff'], conference: 'AFC', division: 'East' },
  // AFC North
  { region: 'Baltimore', name: 'Ravens', abbrev: 'BAL', colors: ['#241773', '#000000'], conference: 'AFC', division: 'North' },
  { region: 'Cincinnati', name: 'Bengals', abbrev: 'CIN', colors: ['#fb4f14', '#000000'], conference: 'AFC', division: 'North' },
  { region: 'Cleveland', name: 'Browns', abbrev: 'CLE', colors: ['#311d00', '#ff3c00'], conference: 'AFC', division: 'North' },
  { region: 'Pittsburgh', name: 'Steelers', abbrev: 'PIT', colors: ['#ffb612', '#101820'], conference: 'AFC', division: 'North' },
  // AFC South
  { region: 'Houston', name: 'Texans', abbrev: 'HOU', colors: ['#03202f', '#a71930'], conference: 'AFC', division: 'South' },
  { region: 'Indianapolis', name: 'Colts', abbrev: 'IND', colors: ['#002c5f', '#a2aaad'], conference: 'AFC', division: 'South' },
  { region: 'Jacksonville', name: 'Jaguars', abbrev: 'JAX', colors: ['#101820', '#d7a22a'], conference: 'AFC', division: 'South' },
  { region: 'Tennessee', name: 'Titans', abbrev: 'TEN', colors: ['#0c2340', '#4b92db'], conference: 'AFC', division: 'South' },
  // AFC West
  { region: 'Denver', name: 'Broncos', abbrev: 'DEN', colors: ['#fb4f14', '#002244'], conference: 'AFC', division: 'West' },
  { region: 'Kansas City', name: 'Chiefs', abbrev: 'KC', colors: ['#e31837', '#ffb81c'], conference: 'AFC', division: 'West' },
  { region: 'Las Vegas', name: 'Raiders', abbrev: 'LV', colors: ['#000000', '#a5acaf'], conference: 'AFC', division: 'West' },
  { region: 'Los Angeles', name: 'Chargers', abbrev: 'LAC', colors: ['#0080c6', '#ffc20e'], conference: 'AFC', division: 'West' },
  // NFC East
  { region: 'Dallas', name: 'Cowboys', abbrev: 'DAL', colors: ['#003594', '#869397'], conference: 'NFC', division: 'East' },
  { region: 'New York', name: 'Giants', abbrev: 'NYG', colors: ['#0b2265', '#a71930'], conference: 'NFC', division: 'East' },
  { region: 'Philadelphia', name: 'Eagles', abbrev: 'PHI', colors: ['#004c54', '#a5acaf'], conference: 'NFC', division: 'East' },
  { region: 'Washington', name: 'Commanders', abbrev: 'WAS', colors: ['#5a1414', '#ffb612'], conference: 'NFC', division: 'East' },
  // NFC North
  { region: 'Chicago', name: 'Bears', abbrev: 'CHI', colors: ['#0b162a', '#c83803'], conference: 'NFC', division: 'North' },
  { region: 'Detroit', name: 'Lions', abbrev: 'DET', colors: ['#0076b6', '#b0b7bc'], conference: 'NFC', division: 'North' },
  { region: 'Green Bay', name: 'Packers', abbrev: 'GB', colors: ['#203731', '#ffb612'], conference: 'NFC', division: 'North' },
  { region: 'Minnesota', name: 'Vikings', abbrev: 'MIN', colors: ['#4f2683', '#ffc62f'], conference: 'NFC', division: 'North' },
  // NFC South
  { region: 'Atlanta', name: 'Falcons', abbrev: 'ATL', colors: ['#a71930', '#000000'], conference: 'NFC', division: 'South' },
  { region: 'Carolina', name: 'Panthers', abbrev: 'CAR', colors: ['#0085ca', '#101820'], conference: 'NFC', division: 'South' },
  { region: 'New Orleans', name: 'Saints', abbrev: 'NO', colors: ['#d3bc8d', '#101820'], conference: 'NFC', division: 'South' },
  { region: 'Tampa Bay', name: 'Buccaneers', abbrev: 'TB', colors: ['#d50a0a', '#34302b'], conference: 'NFC', division: 'South' },
  // NFC West
  { region: 'Arizona', name: 'Cardinals', abbrev: 'ARI', colors: ['#97233f', '#000000'], conference: 'NFC', division: 'West' },
  { region: 'Los Angeles', name: 'Rams', abbrev: 'LAR', colors: ['#003594', '#ffa300'], conference: 'NFC', division: 'West' },
  { region: 'San Francisco', name: '49ers', abbrev: 'SF', colors: ['#aa0000', '#b3995d'], conference: 'NFC', division: 'West' },
  { region: 'Seattle', name: 'Seahawks', abbrev: 'SEA', colors: ['#002244', '#69be28'], conference: 'NFC', division: 'West' },
]

export const SALARY_CAP = 224_000_000

export function generateTeams(): Omit<Team, 'id'>[] {
  return TEAM_SEED.map((t) => ({ ...t, capSpace: SALARY_CAP }))
}

/** Static team metadata in generation order, for pickers that run before a league exists. */
export const TEAM_PREVIEWS = TEAM_SEED

export function divisionKey(conference: Conference, division: Division) {
  return `${conference} ${division}`
}
