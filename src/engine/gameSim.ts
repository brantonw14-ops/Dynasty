import type { Player } from '../types'
import { randNormal, type Rng } from './rng'

/**
 * Box-score level sim: each team's offensive strength is derived from its
 * skill-position + OL ratings, defense from DL/LB/CB/S. No play-by-play yet —
 * this is the v1 placeholder to get a playable season loop; a drive-level
 * sim can replace this function without touching callers.
 */
function teamStrength(roster: Player[], positions: string[]) {
  const relevant = roster.filter((p) => positions.includes(p.position))
  if (relevant.length === 0) return 50
  return relevant.reduce((sum, p) => sum + p.ratings.overall, 0) / relevant.length
}

export interface SimResult {
  homeScore: number
  awayScore: number
}

export function simGame(rng: Rng, homeRoster: Player[], awayRoster: Player[]): SimResult {
  const offense = ['QB', 'RB', 'WR', 'TE', 'OL']
  const defense = ['DL', 'LB', 'CB', 'S']

  const homeOff = teamStrength(homeRoster, offense)
  const homeDef = teamStrength(homeRoster, defense)
  const awayOff = teamStrength(awayRoster, offense)
  const awayDef = teamStrength(awayRoster, defense)

  const homeExpected = 20 + (homeOff - awayDef) * 0.35 + 2 // home-field edge
  const awayExpected = 20 + (awayOff - homeDef) * 0.35

  const homeScore = Math.max(0, Math.round(randNormal(rng, homeExpected, 8)))
  const awayScore = Math.max(0, Math.round(randNormal(rng, awayExpected, 8)))

  return { homeScore, awayScore }
}
