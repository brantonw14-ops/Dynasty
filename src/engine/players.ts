import type { Player, Position, Ratings } from '../types'
import { POSITION_AGE_PROFILE } from './ages'
import { randomName } from './names'
import { randInt, randNormal, type Rng } from './rng'
import { SALARY_CAP } from './teams'
import { marketSalary } from './salary'

const POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P']

// Roughly how many of each position a 53-man roster carries (sums to
// exactly 53 - real rosters often run a bit deeper at OL than skill
// positions, so that's where the extra spot over a round-number split goes).
export const ROSTER_SHAPE: Record<Position, number> = {
  QB: 3, RB: 4, WR: 6, TE: 3, OL: 10, DL: 8, LB: 7, CB: 6, S: 4, K: 1, P: 1,
}

/** A real NFL team must carry a 53-man active roster to start the season. */
export const MIN_ROSTER_SIZE = 53

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

export function clamp(n: number, min = 40, max = 99) {
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * The three attributes that actually define each position, in attr1/attr2/
 * attr3 order - a player's overall is derived solely from these, nothing
 * else. Labels are for display only; the underlying fields are always
 * named attr1/attr2/attr3 regardless of position.
 */
export const POSITION_ATTRIBUTES: Record<Position, [string, string, string]> = {
  QB: ['Accuracy', 'Decision Making', 'Playmaking'],
  RB: ['Speed', 'Break Tackle', 'Vision'],
  WR: ['Speed', 'Catching', 'Route Running'],
  TE: ['Speed', 'Catching', 'Route Running'],
  OL: ['Pass Block', 'Run Block', 'Strength'],
  DL: ['Pass Rush', 'Run Stop', 'Tackling'],
  LB: ['Play Recognition', 'Tackling', 'Speed'],
  CB: ['Speed', 'Man Coverage', 'Zone Coverage'],
  S: ['Speed', 'Man Coverage', 'Zone Coverage'],
  K: ['Kick Accuracy', 'Kick Power', 'Clutch Gene'],
  P: ['Kick Accuracy', 'Kick Power', 'Clutch Gene'],
}

// QBs, kickers, and punters rely far more on experience/technique than
// athleticism, so real careers for these positions often extend (or even
// peak) well into their 30s. Every other position's ceiling should reflect
// the much more typical pattern of decline with age.
export const AGE_DECLINE_EXEMPT_POSITIONS: ReadonlySet<Position> = new Set(['QB', 'K', 'P'])

/**
 * How much higher a player's potential can sit above their current overall,
 * factoring in age. A 22-year-old prospect can plausibly still have a lot
 * of unrealized upside; a 30-year-old at a decline-prone position almost
 * never does - real careers overwhelmingly get worse with age past their
 * mid-20s, with only a small fraction of outlier players (roughly 10% here)
 * still improving. QB/K/P are exempt and keep the full age-independent
 * upside range.
 */
export function potentialGap(rng: Rng, position: Position, age: number): number {
  const baseGap = Math.abs(randNormal(rng, 8, 6))
  if (AGE_DECLINE_EXEMPT_POSITIONS.has(position)) return baseGap

  const peakAge = 24
  if (age <= peakAge) return baseGap

  const declineFactor = Math.max(0, 1 - (age - peakAge) * 0.18)
  const lateBloomer = rng() < 0.1
  return lateBloomer ? baseGap * Math.max(0.5, declineFactor) : baseGap * declineFactor
}

export function generateRatings(rng: Rng, position: Position, age: number, ratingOffset = 0): Ratings {
  // A player's three attributes aren't independent draws - a generational
  // talent tends to be good at everything, a replacement-level guy weak
  // across the board. Drawing a shared "talent" level first and then
  // scattering each attribute around it (instead of three fully
  // independent rolls) keeps that correlation and restores the wide
  // overall spread real overalls have (a handful of 90+ studs, a long
  // tail down toward the floor) - averaging three independent rolls on
  // their own collapses toward the mean and produces almost no stars.
  const talent = randNormal(rng, 68 + ratingOffset, 11)
  let attr1 = clamp(randNormal(rng, talent, 8))
  let attr2 = clamp(randNormal(rng, talent, 8))
  let attr3 = clamp(randNormal(rng, talent, 8))
  let overall = clamp((attr1 + attr2 + attr3) / 3)

  // Overall is solely the average of the three attributes, but every player
  // still needs to clear the roster floor - if the raw draw lands below it,
  // lift all three by the same amount rather than special-casing overall.
  if (overall < MIN_OVERALL) {
    const boost = MIN_OVERALL - overall
    attr1 = clamp(attr1 + boost)
    attr2 = clamp(attr2 + boost)
    attr3 = clamp(attr3 + boost)
    overall = clamp((attr1 + attr2 + attr3) / 3, MIN_OVERALL, 99)
  }

  // Potential is a ceiling, so it can never be below the player's own overall.
  const potential = clamp(overall + potentialGap(rng, position, age), overall, 99)
  return { overall, potential, attr1, attr2, attr3 }
}

/**
 * Salary scales with position, overall rating, and age using the same
 * market-rate curve free agency/trades use, with some random variance
 * layered on top.
 */
function generateContractSalary(rng: Rng, position: Position, overall: number, age: number, spendFactor = 1) {
  const base = marketSalary(position, overall, age)
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
  // A fresh roster's age spread should already look like the position and
  // like a real roster's pyramid shape - mostly players in their early-to-
  // mid 20s with a shrinking tail of veterans, not an even spread up to
  // the position's retirement age (which would start the league with an
  // unrealistic wave of players already near retirement). Squaring the
  // random draw skews it toward the young end; the ceiling itself is well
  // below where retirement odds start climbing, so day-one rosters aren't
  // already sitting on the retirement cliff.
  const { averageRetirement, maxAge } = POSITION_AGE_PROFILE[position]
  const ageCeiling = Math.min(averageRetirement - 1, maxAge)
  const span = Math.max(1, ageCeiling - 21)
  const skewedAge = 21 + Math.floor(Math.pow(rng(), 1.8) * (span + 1))
  const age = clamp(Math.min(skewedAge, ageCeiling) + Math.round(strength?.ageOffset ?? 0), 21, maxAge)
  const ratings = generateRatings(rng, position, age, strength?.ratingOffset ?? 0)
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
            salary: generateContractSalary(rng, position, ratings.overall, age, strength?.spendFactor ?? 1),
            yearsLeft: randInt(rng, 1, 4),
          },
    retired: false,
    injury: null,
    depthOrder: 0,
    // These players weren't actually drafted through this league's own
    // draft (it's day one) - estimate how many seasons they've played from
    // age alone, assuming a typical entry age of 22.
    experience: Math.max(0, age - 22),
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

/**
 * Real NFL free agency is never actually empty - there's always a pool of
 * unsigned players around the league: camp cuts, guys between teams,
 * replacement-level depth nobody's bothered to sign. Mostly replacement
 * level (a below-average skew), with an occasional useful veteran mixed
 * in, spread across positions in roughly the same shape a roster carries.
 */
export function generateStreetFreeAgents(rng: Rng, count: number): Omit<Player, 'id'>[] {
  const weights = POSITIONS.map((p) => ROSTER_SHAPE[p])
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const players: Omit<Player, 'id'>[] = []
  for (let i = 0; i < count; i++) {
    let r = rng() * totalWeight
    let position = POSITIONS[POSITIONS.length - 1]
    for (let j = 0; j < POSITIONS.length; j++) {
      r -= weights[j]
      if (r <= 0) {
        position = POSITIONS[j]
        break
      }
    }
    // Skewed toward replacement level (skill < 0 most of the time), with a
    // long enough tail that an occasional above-average name shows up too.
    const skill = -0.5 + randNormal(rng, 0, 0.6)
    const strength: TeamStrength = { skill, ratingOffset: skill * 6, ageOffset: skill * 1.5, spendFactor: 1 }
    players.push(generatePlayer(rng, position, null, strength))
  }
  return players
}

/** Depth-chart rank to give a newly-acquired player: goes to the bottom of their new team's group. */
export function nextDepthOrder(existingRoster: { position: Position; depthOrder: number }[], position: Position) {
  const atPosition = existingRoster.filter((p) => p.position === position)
  return atPosition.length === 0 ? 0 : Math.max(...atPosition.map((p) => p.depthOrder)) + 1
}

// Roughly how many players at each position see meaningful game-day snaps -
// used both to weight a position's contribution to the team-wide overall
// rating, and to mark who's a "starter" vs "bench" on the roster screen.
export const STARTER_COUNTS: Record<Position, number> = {
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
