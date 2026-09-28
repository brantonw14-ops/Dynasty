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
/**
 * Exported so the UI can flag "at risk to retire next offseason" players -
 * note that in this sim, retirement is purely age/position-driven and does
 * not look at contract status at all, so extending a player's deal doesn't
 * change their retirement odds (same as real life: a player can retire
 * under contract). The practical value of surfacing this is knowing to get
 * final value via a trade, not "saving" them by extending.
 */
export function retirementChance(position: Player['position'], age: number, overall?: number) {
  const { averageRetirement, maxAge } = POSITION_AGE_PROFILE[position]
  if (age >= maxAge) return 1
  if (age < averageRetirement - 8) return 0

  // Steepness tuned (via simulation) so the population's actual mean
  // retirement age lands on `averageRetirement`, not just its median -
  // a logistic curve's 50/50 point alone isn't enough since this is a
  // sequential year-by-year survival process, not a one-shot draw.
  const baseChance = 1 / (1 + Math.exp(-(age - averageRetirement) * 1.3))

  // A player still playing at a genuinely high level has real incentive
  // (and real NFL precedent - Brady, Rice, Vinatieri, Adams...) to keep
  // going past the point an average player at his position would hang it
  // up. Never near-guarantees retirement even at elite overall - once the
  // hard maxAge cutoff above is reached it's still final - but meaningfully
  // extends a star's effective career instead of every player at a
  // position sharing one age curve regardless of how well they still play.
  if (overall == null) return baseChance
  const qualityFactor = overall >= 88 ? 0.25 : overall >= 82 ? 0.45 : overall >= 75 ? 0.7 : 1
  return baseChance * qualityFactor
}

export function ageAndRetire(rng: Rng, players: Player[]): { retiredIds: number[]; agedPlayers: Player[] } {
  const retiredIds: number[] = []
  const agedPlayers: Player[] = []

  for (const p of players) {
    const nextAge = p.age + 1
    if (rng() < retirementChance(p.position, nextAge, p.ratings.overall)) {
      retiredIds.push(p.id)
    } else {
      agedPlayers.push({ ...p, age: nextAge, experience: (p.experience ?? 0) + 1 })
    }
  }

  return { retiredIds, agedPlayers }
}
