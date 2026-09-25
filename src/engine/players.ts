import type { Player, Position, Ratings } from '../types'
import { randomName } from './names'
import { randInt, randNormal, type Rng } from './rng'
import { SALARY_CAP } from './teams'
import { marketSalary } from './salary'

const POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P']

// Roughly how many of each position a 53-man roster carries.
export const ROSTER_SHAPE: Record<Position, number> = {
  QB: 3, RB: 4, WR: 6, TE: 3, OL: 9, DL: 8, LB: 7, CB: 6, S: 4, K: 1, P: 1,
}

export function rosterNeeds(roster: Player[]): Position[] {
  const counts: Partial<Record<Position, number>> = {}
  for (const p of roster) counts[p.position] = (counts[p.position] ?? 0) + 1

  const needs: Position[] = []
  for (const pos of Object.keys(ROSTER_SHAPE) as Position[]) {
    const have = counts[pos] ?? 0
    const want = ROSTER_SHAPE[pos]
    for (let i = have; i < want; i++) needs.push(pos)
  }
  return needs
}

export const MIN_OVERALL = 55

function clamp(n: number, min = 40, max = 99) {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function generateRatings(rng: Rng, ratingOffset = 0): Ratings {
  // Mean shifted up from the old 60 so a 55 floor doesn't pile up too much
  // of the distribution right at the minimum.
  const base = randNormal(rng, 68 + ratingOffset, 12)
  const overall = clamp(base, MIN_OVERALL, 99)
  // Potential is a ceiling, so it can never be below the player's own overall.
  const potential = clamp(overall + Math.abs(randNormal(rng, 8, 6)), overall, 99)
  return {
    overall,
    speed: clamp(randNormal(rng, 60, 15)),
    strength: clamp(randNormal(rng, 60, 15)),
    agility: clamp(randNormal(rng, 60, 15)),
    awareness: clamp(randNormal(rng, 55, 15)),
    potential,
    accuracy: clamp(randNormal(rng, 60 + ratingOffset, 14)),
    decisionMaking: clamp(randNormal(rng, 60 + ratingOffset, 14)),
    playmaking: clamp(randNormal(rng, 60 + ratingOffset, 14)),
  }
}

/**
 * Salary scales with overall rating and age using the same market-rate
 * curve free agency/trades use, with some random variance layered on top.
 */
function generateContractSalary(rng: Rng, overall: number, age: number, spendFactor = 1) {
  const base = marketSalary(overall, age)
  return Math.round(base * (0.85 + rng() * 0.3) * spendFactor)
}

/**
 * Real NFL teams don't start each year dead even - some are stacked
 * contenders, some are rebuilding. A team's strength is one random draw
 * (not per-player) so it consistently shapes the whole roster: better
 * teams skew a bit older (proven vets) and spend more of their cap on
 * talent; rebuilding teams skew younger (developing) with cheaper deals
 * and more space left over.
 */
export interface TeamStrength {
  skill: number
  ratingOffset: number
  ageOffset: number
  spendFactor: number
}

export function generateTeamStrength(rng: Rng): TeamStrength {
  // Roughly a z-score: most teams cluster near 0, a handful sit at the extremes.
  const skill = randNormal(rng, 0, 1)
  return {
    skill,
    ratingOffset: skill * 6,
    ageOffset: skill * 1.5,
    spendFactor: 1 + skill * 0.12,
  }
}

export function generatePlayer(
  rng: Rng,
  position: Position,
  teamId: number | null,
  strength?: TeamStrength,
): Omit<Player, 'id'> {
  const { firstName, lastName } = randomName(rng)
  const age = clamp(randInt(rng, 21, 33) + Math.round(strength?.ageOffset ?? 0), 21, 38)
  const ratings = generateRatings(rng, strength?.ratingOffset ?? 0)
  return {
    firstName,
    lastName,
    age,
    position,
    teamId,
    ratings,
    contract:
      teamId === null
        ? null
        : {
            salary: generateContractSalary(rng, ratings.overall, age, strength?.spendFactor ?? 1),
            yearsLeft: randInt(rng, 1, 4),
          },
    retired: false,
    injury: null,
    depthOrder: 0,
  }
}

/** Assigns depth-chart rank (0 = starter) within each position group, best overall first. */
export function assignDepthOrder<T extends { position: Position; ratings: { overall: number } }>(
  players: T[],
): (T & { depthOrder: number })[] {
  const byPosition = new Map<Position, T[]>()
  for (const p of players) {
    const list = byPosition.get(p.position) ?? []
    list.push(p)
    byPosition.set(p.position, list)
  }
  const result: (T & { depthOrder: number })[] = []
  for (const list of byPosition.values()) {
    const sorted = [...list].sort((a, b) => b.ratings.overall - a.ratings.overall)
    sorted.forEach((p, i) => result.push({ ...p, depthOrder: i }))
  }
  return result
}

export function generateRosterForTeam(rng: Rng, teamId: number): Omit<Player, 'id'>[] {
  const strength = generateTeamStrength(rng)
  let players: Omit<Player, 'id'>[] = []
  for (const pos of POSITIONS) {
    const count = ROSTER_SHAPE[pos]
    for (let i = 0; i < count; i++) {
      players.push(generatePlayer(rng, pos, teamId, strength))
    }
  }
  players = assignDepthOrder(players)

  // Real rosters are never allowed over the cap, but how much room is left
  // under it should track team strength: a stacked contender spent up
  // close to the cap building that roster (little room left), while a
  // rebuilding team left plenty on the table. Without this, every team
  // that happened to generate over its ceiling got scaled down to the
  // *same* fixed ceiling regardless of talent, so a great team and a
  // mediocre one ended up with identical cap space.
  const maxSpendFraction = Math.max(0.72, Math.min(0.98, 0.85 + strength.skill * 0.06))
  const totalSalary = players.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
  const maxSpend = SALARY_CAP * maxSpendFraction
  if (totalSalary > maxSpend) {
    const scale = maxSpend / totalSalary
    for (const p of players) {
      if (p.contract) p.contract.salary = Math.round(p.contract.salary * scale)
    }
  }

  return players
}

/** Depth-chart rank to give a newly-acquired player: goes to the bottom of their new team's group. */
export function nextDepthOrder(existingRoster: { position: Position; depthOrder: number }[], position: Position) {
  const atPosition = existingRoster.filter((p) => p.position === position)
  return atPosition.length === 0 ? 0 : Math.max(...atPosition.map((p) => p.depthOrder)) + 1
}

// Roughly how many players at each position see meaningful game-day snaps -
// used to weight a position's contribution to the team-wide overall rating.
const STARTER_COUNTS: Record<Position, number> = {
  QB: 1, RB: 2, WR: 3, TE: 1, OL: 5, DL: 4, LB: 3, CB: 3, S: 2, K: 1, P: 1,
}

/**
 * A position group's overall isn't a flat average of the whole depth chart -
 * the starter and the next man up matter far more than the 3rd/4th string
 * guys who barely see the field. Weights each player's contribution by
 * depth-chart rank (starter counts full, each rank down counts less).
 */
export function computePositionOverall(players: { depthOrder: number; ratings: { overall: number } }[]): number {
  if (players.length === 0) return 0
  const sorted = [...players].sort((a, b) => a.depthOrder - b.depthOrder)
  let weightedSum = 0
  let weightTotal = 0
  sorted.forEach((p, i) => {
    const weight = Math.pow(0.6, i)
    weightedSum += p.ratings.overall * weight
    weightTotal += weight
  })
  return weightTotal > 0 ? weightedSum / weightTotal : 0
}

/** Team-wide overall: each position's (starter-weighted) overall, weighted again by how many of that position actually play. */
export function computeTeamOverall(
  roster: { position: Position; depthOrder: number; ratings: { overall: number } }[],
): number {
  const byPosition = new Map<Position, typeof roster>()
  for (const p of roster) {
    const list = byPosition.get(p.position) ?? []
    list.push(p)
    byPosition.set(p.position, list)
  }
  let sum = 0
  let weightTotal = 0
  for (const [position, group] of byPosition) {
    const weight = STARTER_COUNTS[position] ?? 1
    sum += computePositionOverall(group) * weight
    weightTotal += weight
  }
  return weightTotal > 0 ? sum / weightTotal : 0
}

export type TeamOutlook = 'rebuilding' | 'contender' | 'superbowl'

export function classifyTeamOutlook(roster: { ratings: { overall: number } }[]): TeamOutlook {
  const avgOverall = roster.reduce((sum, p) => sum + p.ratings.overall, 0) / roster.length
  if (avgOverall >= 73) return 'superbowl'
  if (avgOverall >= 68) return 'contender'
  return 'rebuilding'
}
