import type { Player, Position } from '../types'
import { passerRating, type PlayerBoxScore } from './gameSim'
import { clamp } from './players'
import type { Rng } from './rng'

/**
 * Whether a single game was clearly a good or bad one for this player, by
 * position-appropriate box score thresholds. Most games are neither (too
 * ordinary to move the needle either way) - returns null in that case.
 */
function gameOutcome(position: Position, box: PlayerBoxScore): 'good' | 'bad' | null {
  switch (position) {
    case 'QB': {
      if (box.passAttempts < 5) return null
      const rating = passerRating(box.passAttempts, box.passCompletions, box.passYards, box.passTDs, box.interceptions)
      if (rating >= 105) return 'good'
      if (rating <= 55) return 'bad'
      return null
    }
    case 'RB': {
      if (box.rushAttempts < 5) return null
      const ypc = box.rushYards / box.rushAttempts
      if (box.rushYards >= 90 || (ypc >= 5 && box.rushTDs >= 1)) return 'good'
      if (ypc < 2.8 && box.rushAttempts >= 8) return 'bad'
      return null
    }
    case 'WR':
    case 'TE': {
      if (box.recYards >= 90 || box.recTDs >= 2) return 'good'
      return null
    }
    case 'OL': {
      if (box.pancakes >= 5 && box.sacksAllowed === 0) return 'good'
      if (box.sacksAllowed >= 2) return 'bad'
      return null
    }
    case 'DL':
    case 'LB': {
      if (box.sacks >= 1.5 || box.tacklesForLoss >= 3 || box.defInterceptions >= 1) return 'good'
      return null
    }
    case 'CB':
    case 'S': {
      if (box.defInterceptions >= 1 || box.passBreakups >= 2) return 'good'
      if (box.yardsAllowed >= 100) return 'bad'
      return null
    }
    case 'K': {
      const attempts = box.fieldGoalsAttempted + box.extraPointsAttempted
      if (attempts === 0) return null
      const missed = box.fieldGoalsAttempted - box.fieldGoalsMade + (box.extraPointsAttempted - box.extraPointsMade)
      if (missed === 0) return 'good'
      if (missed >= 2) return 'bad'
      return null
    }
    default:
      return null
  }
}

export type PlayerPerformanceUpdate = { id: number } & Partial<Player>

/**
 * Nudges a roster's ratings based on how each player actually played this
 * game - a standout performance has a real (but not guaranteed) chance to
 * bump a player's overall a point closer to their potential; a rough game
 * builds toward a slump, and three bad games in a row risks knocking a
 * point off. Also sets `trend` so the roster screen can show an up/down
 * arrow for players who are heating up or cooling off. Returns partial
 * updates (only the fields that actually changed) rather than full player
 * objects, so callers can safely merge these with other same-week updates
 * (e.g. injuries) without one clobbering the other.
 */
export function applyGamePerformance(
  rng: Rng,
  roster: Player[],
  box: Map<number, PlayerBoxScore>,
): PlayerPerformanceUpdate[] {
  const updates: PlayerPerformanceUpdate[] = []

  for (const p of roster) {
    const playerBox = box.get(p.id)
    if (!playerBox) continue
    const outcome = gameOutcome(p.position, playerBox)
    if (!outcome) continue

    if (outcome === 'good') {
      const canGrow = p.ratings.overall < p.ratings.potential
      if (canGrow && rng() < 0.1) {
        const overall = clamp(p.ratings.overall + 1, 40, p.ratings.potential)
        updates.push({ id: p.id, ratings: { ...p.ratings, overall }, trend: 'up', badStreak: 0 })
      } else if (p.trend !== 'up' || p.badStreak) {
        updates.push({ id: p.id, trend: 'up', badStreak: 0 })
      }
    } else {
      const streak = (p.badStreak ?? 0) + 1
      if (streak >= 3 && rng() < 0.25) {
        const overall = clamp(p.ratings.overall - 1, 40, 99)
        updates.push({ id: p.id, ratings: { ...p.ratings, overall }, trend: 'down', badStreak: 0 })
      } else {
        updates.push({ id: p.id, badStreak: streak, trend: streak >= 2 ? 'down' : p.trend })
      }
    }
  }

  return updates
}
