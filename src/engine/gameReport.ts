import type { PlayerGameStats, Position } from '../types'
import { passerRating } from './gameSim'

export type GameOutcomeTag = 'good' | 'bad'

/**
 * Whether a single game was clearly a good or bad one for this player, by
 * position-appropriate box score thresholds - mirrors the thresholds
 * inSeasonProgression uses mid-sim, but works off the persisted
 * PlayerGameStats row (post-game report) instead of the transient
 * PlayerBoxScore used while a game is being simulated.
 */
export function classifyGamePerformance(position: Position, s: PlayerGameStats): GameOutcomeTag | null {
  switch (position) {
    case 'QB': {
      if (s.passAttempts < 5) return null
      const rating = passerRating(s.passAttempts, s.passCompletions, s.passYards, s.passTDs, s.interceptions)
      if (rating >= 105) return 'good'
      if (rating <= 55) return 'bad'
      return null
    }
    case 'RB': {
      if (s.rushAttempts < 5) return null
      const ypc = s.rushYards / s.rushAttempts
      if (s.rushYards >= 90 || (ypc >= 5 && s.rushTDs >= 1)) return 'good'
      if (ypc < 2.8 && s.rushAttempts >= 8) return 'bad'
      return null
    }
    case 'WR':
    case 'TE': {
      if (s.recYards >= 90 || s.recTDs >= 2) return 'good'
      return null
    }
    case 'OL': {
      if (s.pancakes >= 5 && s.sacksAllowed === 0) return 'good'
      if (s.sacksAllowed >= 2) return 'bad'
      return null
    }
    case 'DL':
    case 'LB': {
      if (s.sacks >= 1.5 || s.tacklesForLoss >= 3 || s.defInterceptions >= 1) return 'good'
      return null
    }
    case 'CB':
    case 'S': {
      if (s.defInterceptions >= 1 || s.passBreakups >= 2) return 'good'
      if (s.yardsAllowed >= 100) return 'bad'
      return null
    }
    case 'K': {
      const attempts = s.fieldGoalsAttempted + s.extraPointsAttempted
      if (attempts === 0) return null
      const missed = s.fieldGoalsAttempted - s.fieldGoalsMade + (s.extraPointsAttempted - s.extraPointsMade)
      if (missed === 0) return 'good'
      if (missed >= 2) return 'bad'
      return null
    }
    default:
      return null
  }
}

/** A one-line human-readable blurb backing up why this performance was tagged good/bad. */
export function performanceBlurb(position: Position, s: PlayerGameStats, tag: GameOutcomeTag): string {
  switch (position) {
    case 'QB': {
      const rating = passerRating(s.passAttempts, s.passCompletions, s.passYards, s.passTDs, s.interceptions)
      return `${s.passCompletions}/${s.passAttempts}, ${s.passYards} yds, ${s.passTDs} TD, ${s.interceptions} INT (${rating.toFixed(1)} rating)`
    }
    case 'RB':
      return `${s.rushAttempts} car, ${s.rushYards} yds (${(s.rushYards / Math.max(1, s.rushAttempts)).toFixed(1)} ypc)`
    case 'WR':
    case 'TE':
      return `${s.receptions} rec, ${s.recYards} yds, ${s.recTDs} TD`
    case 'OL':
      return tag === 'good' ? `${s.pancakes} pancakes, no sacks allowed` : `${s.sacksAllowed} sacks allowed`
    case 'DL':
    case 'LB':
      return `${s.sacks} sacks, ${s.tacklesForLoss} TFL, ${s.tackles} tkl`
    case 'CB':
    case 'S':
      return tag === 'good' ? `${s.defInterceptions} INT, ${s.passBreakups} PBU` : `${s.yardsAllowed} yds allowed`
    case 'K': {
      const missed = s.fieldGoalsAttempted - s.fieldGoalsMade + (s.extraPointsAttempted - s.extraPointsMade)
      return tag === 'good' ? `${s.fieldGoalsMade}/${s.fieldGoalsAttempted} FG, perfect on PATs` : `${missed} missed kick(s)`
    }
    default:
      return ''
  }
}

interface TeamGameTotals {
  turnoversCommitted: number
  turnoversForced: number
  sacksAllowed: number
  sacksMade: number
  passYardsAllowed: number
  fieldGoalsMissed: number
}

function aggregateTeamTotals(stats: PlayerGameStats[]): TeamGameTotals {
  const totals: TeamGameTotals = {
    turnoversCommitted: 0,
    turnoversForced: 0,
    sacksAllowed: 0,
    sacksMade: 0,
    passYardsAllowed: 0,
    fieldGoalsMissed: 0,
  }
  for (const s of stats) {
    totals.turnoversCommitted += s.interceptions
    totals.turnoversForced += s.defInterceptions
    totals.sacksAllowed += s.sacksAllowed
    totals.sacksMade += s.sacks
    totals.passYardsAllowed += s.yardsAllowed
    totals.fieldGoalsMissed += s.fieldGoalsAttempted - s.fieldGoalsMade + (s.extraPointsAttempted - s.extraPointsMade)
  }
  return totals
}

/**
 * A plain-English list of what actually decided the game, derived from the
 * box score differential rather than any hidden narrative state - turnovers,
 * pass protection, pass rush, pass defense, and kicking are the categories a
 * box score can actually speak to.
 */
export function buildGameReasons(myStats: PlayerGameStats[], won: boolean, myScore: number, oppScore: number): string[] {
  const mine = aggregateTeamTotals(myStats)
  const reasons: string[] = []

  const turnoverMargin = mine.turnoversForced - mine.turnoversCommitted
  if (turnoverMargin < 0) {
    reasons.push(
      `Turned the ball over ${mine.turnoversCommitted} time(s) while forcing only ${mine.turnoversForced} - a ${turnoverMargin} turnover margin.`,
    )
  } else if (turnoverMargin > 0) {
    reasons.push(
      `Won the turnover battle (+${turnoverMargin}) - forced ${mine.turnoversForced} takeaway(s) while giving up only ${mine.turnoversCommitted}.`,
    )
  }

  if (mine.sacksAllowed >= 3) {
    reasons.push(`Offensive line allowed ${mine.sacksAllowed} sacks - protection broke down.`)
  }
  if (mine.sacksMade >= 3) {
    reasons.push(`Pass rush got home ${mine.sacksMade} times - a big night up front on defense.`)
  }

  if (mine.passYardsAllowed >= 280) {
    reasons.push(`Pass defense allowed ${mine.passYardsAllowed} yards through the air - secondary got exposed.`)
  }

  if (mine.fieldGoalsMissed > 0) {
    reasons.push(`Missed ${mine.fieldGoalsMissed} kick(s) - points left on the field.`)
  }

  const margin = Math.abs(myScore - oppScore)
  if (reasons.length === 0) {
    reasons.push(
      won
        ? 'A clean, well-rounded win - no single unit gave the game away.'
        : `A close, even game (${margin}-point margin) - no glaring weakness, just came up short.`,
    )
  }

  return reasons
}
