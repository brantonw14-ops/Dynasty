import type { Position } from '../types'
import { MIN_OVERALL } from './players'

/**
 * Roughly what the actual highest-paid player at each position earns per
 * year in today's NFL (top-of-market AAV): a 99-overall player in his prime
 * at that position should land right around this number, and it scales
 * down from there - not one flat number for every position. A 99-overall
 * QB commands real top-of-market QB money; a 99-overall kicker does not.
 */
const POSITION_MAX_AAV: Record<Position, number> = {
  QB: 60_000_000,
  DL: 40_000_000,
  OL: 30_000_000,
  WR: 35_000_000,
  CB: 30_000_000,
  LB: 28_000_000,
  S: 22_000_000,
  TE: 17_000_000,
  RB: 16_000_000,
  K: 6_000_000,
  P: 5_000_000,
}

const SALARY_FLOOR = 900_000

/**
 * Market-rate salary for a player, based on position, Madden-style overall
 * rating, and age. Talent scales convexly (elite players are paid far more
 * than the gap in overall alone would suggest, same as real football) up to
 * that position's real-world ceiling, and age applies a decline discount on
 * top.
 */
export function marketSalary(position: Position, overall: number, age: number): number {
  const talent = Math.max(0, overall - MIN_OVERALL) / (99 - MIN_OVERALL)
  const talentFactor = Math.pow(talent, 2.4)
  const ceiling = POSITION_MAX_AAV[position]
  const base = SALARY_FLOOR + talentFactor * (ceiling - SALARY_FLOOR)

  const ageFactor =
    age <= 26 ? 1.05 : age <= 29 ? 1.0 : age <= 32 ? 0.85 : age <= 35 ? 0.65 : 0.45

  return Math.round(base * ageFactor)
}
