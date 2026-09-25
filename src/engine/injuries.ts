import type { Player } from '../types'
import { randInt, type Rng } from './rng'

const INJURY_DESCRIPTIONS = [
  'Hamstring strain',
  'Ankle sprain',
  'Concussion',
  'Knee injury',
  'Shoulder injury',
  'Groin strain',
  'Back spasms',
  'Foot injury',
  'Wrist injury',
  'Rib injury',
]

// Per-player, per-game odds of picking up an injury. Tuned so a 1664-player
// league sees roughly a handful of new injuries each week, not a wave every
// game or none all season.
const INJURY_CHANCE_PER_GAME = 0.003

/** Rolls for new injuries among players who played this game (already healthy ones only). */
export function rollNewInjuries(rng: Rng, players: Player[]): Player[] {
  return players.map((p) => {
    if (p.injury) return p
    if (rng() >= INJURY_CHANCE_PER_GAME) return p

    const severityRoll = rng()
    const weeksRemaining = severityRoll < 0.7 ? randInt(rng, 1, 2) : severityRoll < 0.93 ? randInt(rng, 3, 5) : randInt(rng, 6, 10)
    const description = INJURY_DESCRIPTIONS[randInt(rng, 0, INJURY_DESCRIPTIONS.length - 1)]

    return { ...p, injury: { weeksRemaining, description } }
  })
}

/** Heals injuries by one week, clearing them once time is up. Call once per week simmed. */
export function advanceInjuries(players: Player[]): Player[] {
  return players.map((p) => {
    if (!p.injury) return p
    const weeksRemaining = p.injury.weeksRemaining - 1
    return { ...p, injury: weeksRemaining <= 0 ? null : { ...p.injury, weeksRemaining } }
  })
}
