/**
 * Real college programs with a rough prestige tier (1 = blue-blood
 * powerhouse, 4 = smaller/rebuilding program) - used to scout draft
 * prospects: a great season for a middling program's team suggests the
 * player carried them, while good-but-not-great numbers from a loaded
 * blue-blood roster raise the question of how much was the surrounding
 * talent. Purely flavor for the draft board, not simulated play-by-play.
 */
export interface College {
  name: string
  tier: 1 | 2 | 3 | 4
}

export const COLLEGES: College[] = [
  // Tier 1: perennial powerhouses
  { name: 'Alabama', tier: 1 },
  { name: 'Georgia', tier: 1 },
  { name: 'Ohio State', tier: 1 },
  { name: 'Michigan', tier: 1 },
  { name: 'Texas', tier: 1 },
  { name: 'Oklahoma', tier: 1 },
  { name: 'USC', tier: 1 },
  { name: 'LSU', tier: 1 },
  { name: 'Clemson', tier: 1 },
  { name: 'Notre Dame', tier: 1 },
  // Tier 2: consistently strong programs
  { name: 'Penn State', tier: 2 },
  { name: 'Florida', tier: 2 },
  { name: 'Florida State', tier: 2 },
  { name: 'Oregon', tier: 2 },
  { name: 'Wisconsin', tier: 2 },
  { name: 'Auburn', tier: 2 },
  { name: 'Tennessee', tier: 2 },
  { name: 'Miami', tier: 2 },
  { name: 'Texas A&M', tier: 2 },
  { name: 'Utah', tier: 2 },
  { name: 'Michigan State', tier: 2 },
  { name: 'Ole Miss', tier: 2 },
  // Tier 3: solid mid-major/Power conference programs
  { name: 'Baylor', tier: 3 },
  { name: 'Iowa', tier: 3 },
  { name: 'Kentucky', tier: 3 },
  { name: 'Duke', tier: 3 },
  { name: 'Purdue', tier: 3 },
  { name: 'Northwestern', tier: 3 },
  { name: 'Rutgers', tier: 3 },
  { name: 'Kansas', tier: 3 },
  { name: 'Wake Forest', tier: 3 },
  { name: 'Missouri', tier: 3 },
  { name: 'Cincinnati', tier: 3 },
  { name: 'Boise State', tier: 3 },
  { name: 'Memphis', tier: 3 },
  { name: 'Toledo', tier: 3 },
  // Tier 4: smaller/rebuilding programs
  { name: 'Vanderbilt', tier: 4 },
  { name: 'Kansas State', tier: 4 },
  { name: 'Colorado State', tier: 4 },
  { name: 'Akron', tier: 4 },
  { name: 'Ball State', tier: 4 },
  { name: 'Tulane', tier: 4 },
  { name: 'Marshall', tier: 4 },
  { name: 'Appalachian State', tier: 4 },
  { name: 'Georgia Southern', tier: 4 },
  { name: 'UTSA', tier: 4 },
]
