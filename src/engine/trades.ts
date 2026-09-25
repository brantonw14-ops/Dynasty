import type { Player } from '../types'
import { ROSTER_SHAPE } from './players'
import { SALARY_CAP } from './teams'

/**
 * A single number standing in for "how good/valuable is this player,"
 * combining current ability, upside (for young players), age decline risk,
 * and contract value (a cheap deal for a good player is worth more than
 * the same player on an expensive one).
 */
export function playerValue(p: Player): number {
  let value = p.ratings.overall * 100

  if (p.age <= 26) {
    value += (p.ratings.potential - p.ratings.overall) * 30
  }
  if (p.age >= 30) {
    value -= (p.age - 29) * 150
  }

  if (p.contract) {
    const marketSalary = 500_000 + Math.max(0, p.ratings.overall - 50) * 250_000
    value += (marketSalary - p.contract.salary) / 1000
  }

  return Math.max(0, value)
}

export interface TradeEvaluation {
  accepted: boolean
  reason: string
}

/**
 * Evaluates a proposed trade from the responding team's (`theirRoster`)
 * point of view: they'd be sending away `leaving` and receiving `entering`.
 * Accepts if the value they receive is at least ~90% of what they give up
 * (a little slack so trades aren't impossibly hard to make) and the deal
 * doesn't leave their roster dangerously short at any position or over the
 * salary cap.
 */
export function evaluateTrade(
  theirRoster: Player[],
  leaving: Player[],
  entering: Player[],
): TradeEvaluation {
  const valueLeaving = leaving.reduce((sum, p) => sum + playerValue(p), 0)
  const valueEntering = entering.reduce((sum, p) => sum + playerValue(p), 0)

  if (valueEntering < valueLeaving * 0.9) {
    return { accepted: false, reason: 'Not enough value coming back' }
  }

  const leavingIds = new Set(leaving.map((p) => p.id))
  const resultingRoster = [...theirRoster.filter((p) => !leavingIds.has(p.id)), ...entering]

  const counts = new Map<string, number>()
  for (const p of resultingRoster) counts.set(p.position, (counts.get(p.position) ?? 0) + 1)
  for (const position of Object.keys(ROSTER_SHAPE) as (keyof typeof ROSTER_SHAPE)[]) {
    if ((counts.get(position) ?? 0) === 0 && ROSTER_SHAPE[position] > 0) {
      return { accepted: false, reason: `Would leave them with no players at ${position}` }
    }
  }

  const capUsed = resultingRoster.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
  if (capUsed > SALARY_CAP) {
    return { accepted: false, reason: 'Would put them over the salary cap' }
  }

  return { accepted: true, reason: 'Deal accepted' }
}
