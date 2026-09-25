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

function clamp(n: number, min = 40, max = 99) {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function generateRatings(rng: Rng): Ratings {
  const base = randNormal(rng, 60, 12)
  const potential = clamp(base + Math.abs(randNormal(rng, 8, 6)))
  return {
    overall: clamp(base),
    speed: clamp(randNormal(rng, 60, 15)),
    strength: clamp(randNormal(rng, 60, 15)),
    agility: clamp(randNormal(rng, 60, 15)),
    awareness: clamp(randNormal(rng, 55, 15)),
    potential,
  }
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
    contract: teamId === null ? null : { salary: randInt(rng, 700_000, 8_000_000), yearsLeft: randInt(rng, 1, 4) },
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
