import type { Player } from '../types'
import { POSITION_AGE_PROFILE } from './ages'
import type { Rng } from './rng'

/**
 * Retirement odds follow a logistic curve centered on a position's typical
 * retirement age (50/50 right at that age), rising fast enough on either
 * side that the population's actual average retirement age lands close to
 * that center - then hard-capped at 100% at that position's max age
 * (modeled on the oldest players ever to actually play it), so a kicker or
 * QB can play deep into his late 30s/40s but a running back almost never
 * does.
 */
function retirementChance(position: Player['position'], age: number) {
  const { averageRetirement, maxAge } = POSITION_AGE_PROFILE[position]
  if (age >= maxAge) return 1
  if (age < averageRetirement - 8) return 0

  // Steepness tuned (via simulation) so the population's actual mean
  // retirement age lands on `averageRetirement`, not just its median -
  // a logistic curve's 50/50 point alone isn't enough since this is a
  // sequential year-by-year survival process, not a one-shot draw.
  return 1 / (1 + Math.exp(-(age - averageRetirement) * 1.3))
}

export function ageAndRetire(rng: Rng, players: Player[]): { retiredIds: number[]; agedPlayers: Player[] } {
  const retiredIds: number[] = []
  const agedPlayers: Player[] = []

  for (const p of players) {
    const nextAge = p.age + 1
    if (rng() < retirementChance(p.position, nextAge)) {
      retiredIds.push(p.id)
    } else {
      agedPlayers.push({ ...p, age: nextAge, experience: (p.experience ?? 0) + 1 })
    }
  }

  return { retiredIds, agedPlayers }
}
