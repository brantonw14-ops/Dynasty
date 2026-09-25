import type { Position } from '../types'

/**
 * Real NFL career length varies a lot by position - specialists and
 * quarterbacks play well into their 30s (sometimes 40s), while running
 * backs and receivers are usually done in their late 20s. `averageRetirement`
 * is roughly where a typical career ends; `maxAge` is a hard cutoff modeled
 * on the oldest players ever to actually play the position (Tom Brady/
 * George Blanda at QB, Jerry Rice at WR, Darrell Green at CB, Adam
 * Vinatieri/Morten Andersen at K, etc.) - nobody in the league ever plays
 * past it.
 */
export interface PositionAgeProfile {
  averageRetirement: number
  maxAge: number
}

export const POSITION_AGE_PROFILE: Record<Position, PositionAgeProfile> = {
  QB: { averageRetirement: 32, maxAge: 45 },
  RB: { averageRetirement: 27, maxAge: 37 },
  WR: { averageRetirement: 29, maxAge: 42 },
  TE: { averageRetirement: 29, maxAge: 38 },
  OL: { averageRetirement: 30, maxAge: 44 },
  DL: { averageRetirement: 29, maxAge: 40 },
  LB: { averageRetirement: 29, maxAge: 40 },
  CB: { averageRetirement: 28, maxAge: 42 },
  S: { averageRetirement: 29, maxAge: 40 },
  K: { averageRetirement: 34, maxAge: 47 },
  P: { averageRetirement: 33, maxAge: 45 },
}
