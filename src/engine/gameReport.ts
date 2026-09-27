import type { PlayerGameStats, Position } from '../types'
import { passerRating } from './gameSim'
import type { SeasonGrade } from './seasonPerformance'

export type GameOutcomeTag = 'good' | 'bad'

/**
 * Whether a single game was clearly a good or bad one for this player.
 * Primarily driven by the same league-wide letter grade (A-F, z-scored
 * against position peers for that week) shown on the box score - an A
 * played well, an F played poorly, so the two views of a game agree with
 * each other instead of using separate ad-hoc thresholds. `weekGrade` is
 * that grade for this exact stat line (pass `undefined` if none - too few
 * peers that position/week to grade).
 *
 * A couple of position-specific overrides on top of the grade:
 * - A kicker missing even one extra point is always "bad" - a PAT is a
 *   routine, near-automatic play in the real league, not a coin flip.
 * - A kicker who only attempted PATs (no field goals) never grades "good"
 *   just for being perfect on them - that's the expectation, not a
 *   standout game.
 */
export function classifyGamePerformance(
  position: Position,
  s: PlayerGameStats,
  weekGrade?: SeasonGrade,
): GameOutcomeTag | null {
  if (position === 'K') {
    const patMissed = s.extraPointsAttempted - s.extraPointsMade
    if (patMissed >= 1) return 'bad'
    if (s.fieldGoalsAttempted === 0) return null
  }
  if (position === 'QB' && s.passAttempts < 5) return null
  if (position === 'RB' && s.rushAttempts < 5) return null

  if (weekGrade === 'A') return 'good'
  if (weekGrade === 'F') return 'bad'
  return null
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

export interface HeadlinePlayer {
  playerId: number
  firstName: string
  lastName: string
  position: Position
  overall: number
  stat: PlayerGameStats
}

/** Below this, a player is "just a guy" on the roster - a big game from
 * someone this low is a real surprise, not just a star doing star things. */
const BREAKOUT_OVERALL_CEILING = 68

/**
 * The story of the game, not just the box score - a handful of headline-
 * worthy moments (a signature performance, a breakout from an unheralded
 * player, a defensive takeover, a walk-off kick) so the same names start
 * showing up again and again and a GM gets attached to their roster, not
 * just a stat line. Ordered most-notable-first and capped at 3 so this
 * reads like a recap, not a second box score.
 */
export function buildGameHeadlines(
  players: HeadlinePlayer[],
  won: boolean,
  myScore: number,
  oppScore: number,
): string[] {
  const margin = Math.abs(myScore - oppScore)
  const name = (p: HeadlinePlayer) => `${p.firstName} ${p.lastName}`
  const headlines: { text: string; priority: number }[] = []

  for (const p of players) {
    const s = p.stat
    switch (p.position) {
      case 'QB': {
        if (s.passAttempts < 15) break
        const rating = passerRating(s.passAttempts, s.passCompletions, s.passYards, s.passTDs, s.interceptions)
        if (won && margin <= 8 && rating >= 100) {
          headlines.push({
            text: `${name(p)} delivered when it mattered most - a ${rating.toFixed(1)} passer rating to seal a ${margin}-point win.`,
            priority: 1,
          })
        } else if (s.passYards >= 350 || (s.passTDs >= 4 && s.interceptions === 0)) {
          headlines.push({
            text: `${name(p)} was nearly unstoppable - ${s.passYards} yds, ${s.passTDs} TD, ${s.interceptions} INT.`,
            priority: 2,
          })
        } else if (p.overall < BREAKOUT_OVERALL_CEILING && rating >= 105) {
          headlines.push({
            text: `${name(p)} came out of nowhere - a ${p.overall} overall arm posting a ${rating.toFixed(1)} rating nobody expected.`,
            priority: 3,
          })
        }
        break
      }
      case 'RB': {
        if (s.rushYards >= 150 || s.rushTDs >= 3) {
          headlines.push({
            text: `${name(p)} put together one of the best nights of his career - ${s.rushYards} yds and ${s.rushTDs} TD on the ground.`,
            priority: 2,
          })
        } else if (p.overall < BREAKOUT_OVERALL_CEILING && s.rushYards >= 90) {
          headlines.push({
            text: `${name(p)} broke out - ${s.rushYards} yards is a career night for a ${p.overall} overall back.`,
            priority: 3,
          })
        }
        break
      }
      case 'WR':
      case 'TE': {
        if (s.recYards >= 150 || s.recTDs >= 3) {
          headlines.push({
            text: `${name(p)} torched the secondary - ${s.receptions} rec, ${s.recYards} yds, ${s.recTDs} TD.`,
            priority: 2,
          })
        } else if (p.overall < BREAKOUT_OVERALL_CEILING && s.recYards >= 90) {
          headlines.push({
            text: `${name(p)} had a breakout game - ${s.recYards} yards from a ${p.overall} overall target nobody game-planned for.`,
            priority: 3,
          })
        }
        break
      }
      case 'DL':
      case 'LB':
      case 'CB':
      case 'S': {
        if (s.sacks >= 3 || s.defInterceptions >= 2) {
          headlines.push({
            text: `${name(p)} took the game over on defense - ${s.sacks} sacks, ${s.defInterceptions} INT, ${s.passBreakups} PBU.`,
            priority: 2,
          })
        }
        break
      }
      case 'K': {
        if (s.fieldGoalsMade > 0 && s.longestFieldGoal >= 50 && margin <= 3 && won) {
          headlines.push({
            text: `${name(p)} drilled a ${s.longestFieldGoal}-yard game-winner as time wound down.`,
            priority: 1,
          })
        }
        break
      }
      default:
        break
    }
  }

  const turnoversCommitted = players
    .filter((p) => p.position === 'QB')
    .reduce((sum, p) => sum + p.stat.interceptions, 0)
  if (!won && turnoversCommitted >= 3) {
    headlines.push({ text: `Turnovers doomed this one - ${turnoversCommitted} giveaways nobody could overcome.`, priority: 2 })
  }

  return headlines
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3)
    .map((h) => h.text)
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
