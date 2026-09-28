import type { Position } from '../types'
import { MIN_OVERALL } from './players'

/**
 * What the actual highest-paid player at each position earns per year in
 * today's NFL (top-of-market AAV, per 2026 contract data): a 99-overall
 * player in his prime at that position should land right around this
 * number, and it scales down from there - not one flat number for every
 * position. A 99-overall QB commands real top-of-market QB money; a
 * 99-overall kicker does not. Anchors (2026 AAV): Mahomes $63.4M (QB),
 * Will Anderson >$50M (DL/EDGE), Ja'Marr Chase $38M (WR), Christian
 * Gonzalez $33.75M (CB), Rashawn Slater $28.5M (OL), Kyle Hamilton $25.1M
 * (S), Jahmyr Gibbs ~$22.5M (RB), Fred Warner $21M (LB), Kittle/Pitts $18M
 * (TE), Harrison Butker $6.4M (K), Michael Dickson $3.7M (P).
 */
const POSITION_MAX_AAV: Record<Position, number> = {
  QB: 63_000_000,
  DL: 52_000_000,
  WR: 38_000_000,
  CB: 34_000_000,
  OL: 29_000_000,
  S: 25_000_000,
  RB: 23_000_000,
  LB: 21_000_000,
  TE: 18_000_000,
  K: 6_500_000,
  P: 3_700_000,
}

const SALARY_FLOOR = 900_000

/**
 * Per-year price adjustment for contract length, same real-world dynamic as
 * an actual NFL negotiation: a short "prove it"/franchise-tag-style deal
 * pays a premium per year since the team is taking on no long-term risk,
 * while a longer deal trades a lower AAV for multi-year security - the
 * team's savings on a longer deal's per-year cost more than make up for
 * the extra years guaranteed. Without this, a 1-year and a 4-year deal for
 * the same player paid the exact same AAV, which is what made the "years"
 * dropdown on the resign screen feel like it did nothing.
 */
const CONTRACT_LENGTH_FACTOR: Record<number, number> = {
  1: 1.15,
  2: 1.0,
  3: 0.94,
  4: 0.89,
}

/**
 * Market-rate salary for a player, based on position, Madden-style overall
 * rating, age, and contract length. Talent scales convexly (elite players
 * are paid far more than the gap in overall alone would suggest, same as
 * real football) up to that position's real-world ceiling, age applies a
 * decline discount, and length applies the premium/discount above.
 */
export function marketSalary(position: Position, overall: number, age: number, years = 2): number {
  const talent = Math.max(0, overall - MIN_OVERALL) / (99 - MIN_OVERALL)
  const talentFactor = Math.pow(talent, 2.4)
  const ceiling = POSITION_MAX_AAV[position]
  const base = SALARY_FLOOR + talentFactor * (ceiling - SALARY_FLOOR)

  const ageFactor =
    age <= 26 ? 1.05 : age <= 29 ? 1.0 : age <= 32 ? 0.85 : age <= 35 ? 0.65 : 0.45
  const lengthFactor = CONTRACT_LENGTH_FACTOR[years] ?? 1

  return Math.round(base * ageFactor * lengthFactor)
}
