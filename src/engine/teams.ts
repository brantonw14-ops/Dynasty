import type { Team } from '../types'

// 8-team starter league; expand toward 32 later.
const TEAM_SEED: Array<Pick<Team, 'region' | 'name' | 'abbrev' | 'colors'>> = [
  { region: 'Boston', name: 'Minutemen', abbrev: 'BOS', colors: ['#0c2340', '#c60c30'] },
  { region: 'New York', name: 'Titans', abbrev: 'NY', colors: ['#0b2265', '#a71930'] },
  { region: 'Philadelphia', name: 'Liberty', abbrev: 'PHI', colors: ['#004c54', '#a5acaf'] },
  { region: 'Chicago', name: 'Wolves', abbrev: 'CHI', colors: ['#0b162a', '#c83803'] },
  { region: 'Dallas', name: 'Rustlers', abbrev: 'DAL', colors: ['#003594', '#869397'] },
  { region: 'Denver', name: 'Peaks', abbrev: 'DEN', colors: ['#fb4f14', '#002244'] },
  { region: 'Seattle', name: 'Sound', abbrev: 'SEA', colors: ['#002244', '#69be28'] },
  { region: 'Los Angeles', name: 'Suns', abbrev: 'LA', colors: ['#ffa300', '#003594'] },
]

const SALARY_CAP = 200_000_000

export function generateTeams(): Omit<Team, 'id'>[] {
  return TEAM_SEED.map((t) => ({ ...t, capSpace: SALARY_CAP }))
}

/** Static team metadata in generation order, for pickers that run before a league exists. */
export const TEAM_PREVIEWS = TEAM_SEED
