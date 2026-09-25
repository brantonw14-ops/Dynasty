import { MIN_OVERALL } from './players'

/**
 * Market-rate salary for a player, based on Madden-style overall rating and
 * age - meant to roughly track real NFL average-annual-value scale: a
 * 99-overall player in his prime lands around $55M/yr (the going rate for
 * a top-of-market QB), while a replacement-level 55-overall guy is closer
 * to league minimum. Talent scales convexly (elite players are paid far
 * more than the gap in overall alone would suggest, same as real
 * football), and age applies a decline discount on top.
 */
export function marketSalary(overall: number, age: number): number {
  const talent = Math.max(0, overall - MIN_OVERALL) / (99 - MIN_OVERALL)
  const talentFactor = Math.pow(talent, 2.4)
  const base = 900_000 + talentFactor * 54_000_000

  const ageFactor =
    age <= 26 ? 1.05 : age <= 29 ? 1.0 : age <= 32 ? 0.85 : age <= 35 ? 0.65 : 0.45

  return Math.round(base * ageFactor)
}
