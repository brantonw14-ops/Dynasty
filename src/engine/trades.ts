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

/**
 * A future draft pick's value on the same scale as playerValue: a real
 * first-rounder is worth roughly what a solid young starter is (there's a
 * real chance it becomes one), tapering off fast round to round, and
 * discounted the further out it is (a pick 4 years away is a lot less
 * certain than next year's). Round is 1-7; yearsOut is 1 for next year's
 * draft, 2 for the year after, etc.
 */
export function pickValue(round: number, yearsOut: number): number {
  const baseByRound: Record<number, number> = {
    1: 3200,
    2: 1500,
    3: 800,
    4: 400,
    5: 200,
    6: 100,
    7: 50,
  }
  const base = baseByRound[round] ?? 50
  return base * Math.pow(0.8, Math.max(0, yearsOut - 1))
}

export interface TradeEvaluation {
  accepted: boolean
  reason: string
}

/**
 * Evaluates a proposed trade from the responding team's (`theirRoster`)
 * point of view: they'd be sending away `leaving` (players) and receiving
 * `entering` (players), plus any draft-pick value on each side folded into
 * the same comparison via `extraValueLeaving`/`extraValueEntering`. Accepts
 * if the value they receive is at least ~90% of what they give up (a little
 * slack so trades aren't impossibly hard to make) and the deal doesn't
 * leave their roster dangerously short at any position or over the salary
 * cap. Picks don't affect the roster-shape/cap checks below - only rostered
 * players do.
 */
export function evaluateTrade(
  theirRoster: Player[],
  leaving: Player[],
  entering: Player[],
  extraValueLeaving = 0,
  extraValueEntering = 0,
): TradeEvaluation {
  const valueLeaving = leaving.reduce((sum, p) => sum + playerValue(p), 0) + extraValueLeaving
  const valueEntering = entering.reduce((sum, p) => sum + playerValue(p), 0) + extraValueEntering

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
