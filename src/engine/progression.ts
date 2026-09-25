import type { Player, Ratings } from '../types'
import { randNormal, type Rng } from './rng'

function clamp(n: number, min = 40, max = 99) {
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * Moves a player's ratings one year: young players trend toward their
 * potential, players in their prime hold roughly steady, and players past
 * 29 decline (faster the older they get). Sub-ratings scale proportionally
 * with the overall change so a player's profile (speed vs strength etc.)
 * stays roughly consistent rather than drifting independently.
 */
export function progressRatings(rng: Rng, ratings: Ratings, ageAfterBirthday: number): Ratings {
  let delta: number

  if (ageAfterBirthday <= 26) {
    const gap = ratings.potential - ratings.overall
    delta = gap > 0 ? Math.round(gap * (0.15 + rng() * 0.15)) : Math.round(randNormal(rng, 0, 1))
  } else if (ageAfterBirthday <= 29) {
    delta = Math.round(randNormal(rng, 0, 1.5))
  } else {
    const declineRate = (ageAfterBirthday - 29) * 0.8
    delta = -Math.round(declineRate + rng() * 2)
  }

  const newOverall = clamp(ratings.overall + delta)
  const scale = ratings.overall > 0 ? newOverall / ratings.overall : 1

  return {
    overall: newOverall,
    speed: clamp(ratings.speed * scale),
    strength: clamp(ratings.strength * scale),
    agility: clamp(ratings.agility * scale),
    awareness: clamp(ratings.awareness + (ageAfterBirthday > 29 ? 1 : 0)),
    potential: ratings.potential,
  }
}

export function progressPlayer(rng: Rng, player: Player): Player {
  return { ...player, ratings: progressRatings(rng, player.ratings, player.age) }
}
