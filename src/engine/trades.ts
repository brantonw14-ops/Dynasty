import type { Player } from '../types'
import { ROSTER_SHAPE } from './players'
import { marketSalary } from './salary'
import { SALARY_CAP } from './teams'

/**
 * A single number standing in for "how good/valuable is this player,"
 * combining current ability, upside (for young players), age decline risk,
 * and contract value (a cheap deal for a good player is worth more than
 * the same player on an expensive one).
 */
export function playerValue(p: Player): number {
  // Elite talent is worth far more than raw overall alone suggests - a
  // 95 overall isn't "5% better" than a 90, real rosters are built around
  // a handful of stars and everyone else. This mirrors the convexity of
  // the market-rate salary curve.
  let value = Math.pow(Math.max(0, p.ratings.overall - 40), 2.6) / 2

  if (p.age <= 26) {
    value += (p.ratings.potential - p.ratings.overall) * 30
  }
  if (p.age >= 30) {
    value -= (p.age - 29) * 150
  }

  if (p.contract) {
    const market = marketSalary(p.position, p.ratings.overall, p.age)
    value += (market - p.contract.salary) / 1000
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

  // The better the best player they're giving up, the less willing a real
  // team is to do it without a genuinely comparable piece coming back -
  // no team hands over a 95 overall starter for a stack of 55-60 depth
  // guys just because the raw point totals happen to line up.
  const maxLeavingOverall = leaving.reduce((max, p) => Math.max(max, p.ratings.overall), 0)
  const requiredRatio =
    maxLeavingOverall >= 90 ? 1.5 : maxLeavingOverall >= 85 ? 1.3 : maxLeavingOverall >= 75 ? 1.15 : 1.05

  if (valueEntering < valueLeaving * requiredRatio) {
    return { accepted: false, reason: 'Not enough value coming back' }
  }

  if (
    maxLeavingOverall >= 88 &&
    entering.every((p) => p.ratings.overall < maxLeavingOverall - 15)
  ) {
    return { accepted: false, reason: "They won't give up a player that good without a comparable player coming back" }
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
