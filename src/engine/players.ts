import type { Player, Position, Ratings } from '../types'
import { randomName } from './names'
import { randInt, randNormal, type Rng } from './rng'

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

function generateRatings(rng: Rng): Ratings {
  // Mean shifted up from the old 60 so a 55 floor doesn't pile up too much
  // of the distribution right at the minimum.
  const base = randNormal(rng, 68, 12)
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
  }
}

/**
 * Salary scales with overall rating (roughly matching the market-rate
 * formula free agency/trades use elsewhere), with some random variance.
 * Tuned so a full roster averages well under the cap - real teams carry
 * meaningful cap space, not exactly $0 of it, and leaving room is what
 * makes free agency and trades actually possible instead of instantly
 * cap-blocked.
 */
function generateContractSalary(rng: Rng, overall: number) {
  const base = 450_000 + Math.max(0, overall - MIN_OVERALL) * 170_000
  return Math.round(base * (0.8 + rng() * 0.4))
}

export function generatePlayer(rng: Rng, position: Position, teamId: number | null): Omit<Player, 'id'> {
  const { firstName, lastName } = randomName(rng)
  const age = randInt(rng, 21, 33)
  const ratings = generateRatings(rng)
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
        : { salary: generateContractSalary(rng, ratings.overall), yearsLeft: randInt(rng, 1, 4) },
    retired: false,
  }
}

export function generateRosterForTeam(rng: Rng, teamId: number): Omit<Player, 'id'>[] {
  const players: Omit<Player, 'id'>[] = []
  for (const pos of POSITIONS) {
    const count = ROSTER_SHAPE[pos]
    for (let i = 0; i < count; i++) {
      players.push(generatePlayer(rng, pos, teamId))
    }
  }
  return players
}
