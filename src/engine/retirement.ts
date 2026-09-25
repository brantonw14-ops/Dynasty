import type { Player } from '../types'
import type { Rng } from './rng'

/** Retirement odds rise steeply after 30; nobody plays past ~38. */
function retirementChance(age: number) {
  if (age < 30) return 0
  if (age >= 38) return 1
  return (age - 29) * 0.12
}

export function ageAndRetire(rng: Rng, players: Player[]): { retiredIds: number[]; agedPlayers: Player[] } {
  const retiredIds: number[] = []
  const agedPlayers: Player[] = []

  for (const p of players) {
    const nextAge = p.age + 1
    if (rng() < retirementChance(nextAge)) {
      retiredIds.push(p.id)
    } else {
      agedPlayers.push({ ...p, age: nextAge })
    }
  }

  return { retiredIds, agedPlayers }
}
