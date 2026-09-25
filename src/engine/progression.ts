import type { Player, Ratings } from '../types'
import { randNormal, type Rng } from './rng'

function clamp(n: number, min = 40, max = 99) {
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * Moves a player's ratings one year: young players trend toward their
 * potential, players in their prime hold roughly steady, and players past
 * 29 decline (faster the older they get). The three core attributes scale
 * proportionally with the target overall change, then overall is
 * recomputed from them - it stays solely a function of those three,
 * consistent with how it's generated.
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

  const targetOverall = clamp(ratings.overall + delta)
  const scale = ratings.overall > 0 ? targetOverall / ratings.overall : 1

  const attr1 = clamp(ratings.attr1 * scale)
  const attr2 = clamp(ratings.attr2 * scale)
  const attr3 = clamp(ratings.attr3 * scale)
  const overall = clamp((attr1 + attr2 + attr3) / 3)

  return { overall, potential: ratings.potential, attr1, attr2, attr3 }
}

export function progressPlayer(rng: Rng, player: Player): Player {
  return { ...player, ratings: progressRatings(rng, player.ratings, player.age) }
}
