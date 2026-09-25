import type { Player, PlayerGameStats, Position } from '../types'

function clampPotential(n: number, overall: number) {
  return Math.max(Math.max(40, overall - 10), Math.min(99, Math.round(n)))
}

interface StatTotals {
  passYards: number
  passTDs: number
  interceptions: number
  rushYards: number
  rushTDs: number
  recYards: number
  recTDs: number
  tackles: number
  sacks: number
  tacklesForLoss: number
  passBreakups: number
  defInterceptions: number
  yardsAllowed: number
  pancakes: number
  sacksAllowed: number
  tflsAllowed: number
  fieldGoalsMade: number
  fieldGoalsAttempted: number
  extraPointsMade: number
  extraPointsAttempted: number
  puntCount: number
  puntYards: number
}

function emptyTotals(): StatTotals {
  return {
    passYards: 0,
    passTDs: 0,
    interceptions: 0,
    rushYards: 0,
    rushTDs: 0,
    recYards: 0,
    recTDs: 0,
    tackles: 0,
    sacks: 0,
    tacklesForLoss: 0,
    passBreakups: 0,
    defInterceptions: 0,
    yardsAllowed: 0,
    pancakes: 0,
    sacksAllowed: 0,
    tflsAllowed: 0,
    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    extraPointsMade: 0,
    extraPointsAttempted: 0,
    puntCount: 0,
    puntYards: 0,
  }
}

export function aggregateSeasonStats(stats: PlayerGameStats[]): Map<number, StatTotals> {
  const totals = new Map<number, StatTotals>()
  for (const s of stats) {
    const t = totals.get(s.playerId) ?? emptyTotals()
    t.passYards += s.passYards
    t.passTDs += s.passTDs
    t.interceptions += s.interceptions
    t.rushYards += s.rushYards
    t.rushTDs += s.rushTDs
    t.recYards += s.recYards
    t.recTDs += s.recTDs
    t.tackles += s.tackles
    t.sacks += s.sacks
    t.tacklesForLoss += s.tacklesForLoss
    t.passBreakups += s.passBreakups
    t.defInterceptions += s.defInterceptions
    t.yardsAllowed += s.yardsAllowed
    t.pancakes += s.pancakes
    t.sacksAllowed += s.sacksAllowed
    t.tflsAllowed += s.tflsAllowed
    t.fieldGoalsMade += s.fieldGoalsMade
    t.fieldGoalsAttempted += s.fieldGoalsAttempted
    t.extraPointsMade += s.extraPointsMade
    t.extraPointsAttempted += s.extraPointsAttempted
    t.puntCount += s.puntCount
    t.puntYards += s.puntYards
    totals.set(s.playerId, t)
  }
  return totals
}

/** A rough "how good was this season" number for every position, higher is better. */
function productionScore(position: Position, t: StatTotals): number {
  switch (position) {
    case 'QB':
      return t.passYards + t.passTDs * 20 - t.interceptions * 15 + t.rushYards * 0.5
    case 'RB':
      return t.rushYards + t.recYards * 0.5 + (t.rushTDs + t.recTDs) * 20
    case 'WR':
    case 'TE':
      return t.recYards + t.recTDs * 20
    case 'OL':
      return t.pancakes * 2 - t.sacksAllowed * 6 - t.tflsAllowed * 3
    case 'DL':
    case 'LB':
      return t.tackles + t.sacks * 8 + t.tacklesForLoss * 4 + t.passBreakups * 3 + t.defInterceptions * 10
    case 'CB':
    case 'S':
      return t.tackles * 0.5 + t.passBreakups * 4 + t.defInterceptions * 12 - t.yardsAllowed * 0.05
    case 'K':
      return (
        t.fieldGoalsMade * 3 +
        t.extraPointsMade -
        (t.fieldGoalsAttempted - t.fieldGoalsMade) * 4 -
        (t.extraPointsAttempted - t.extraPointsMade) * 3
      )
    case 'P':
      return t.puntCount > 0 ? (t.puntYards / t.puntCount - 38) * t.puntCount : 0
    default:
      return 0
  }
}

const ALL_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P']

/** Only positions whose production score is meaningful for nudging future potential. */
const SCORED_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE']

/**
 * A player's ceiling isn't fixed - a standout, MVP-caliber season should
 * raise expectations for what they can become, and a genuinely poor one
 * (relative to their position peers who actually played) should lower them.
 * Compares each player's season production to the mean/stdev at their
 * position among players who saw the field, and nudges potential based on
 * how many standard deviations off that average they landed.
 */
export function adjustPotentialForSeason(players: Player[], seasonStats: PlayerGameStats[]): Player[] {
  const totals = aggregateSeasonStats(seasonStats)
  const deltaByPlayerId = new Map<number, number>()

  for (const position of SCORED_POSITIONS) {
    const scored = players
      .filter((p) => p.position === position && totals.has(p.id))
      .map((p) => ({ id: p.id, score: productionScore(position, totals.get(p.id)!) }))
    if (scored.length < 3) continue

    const mean = scored.reduce((sum, s) => sum + s.score, 0) / scored.length
    const variance = scored.reduce((sum, s) => sum + (s.score - mean) ** 2, 0) / scored.length
    const stdev = Math.sqrt(variance)
    if (stdev <= 0) continue

    for (const s of scored) {
      const z = (s.score - mean) / stdev
      let delta = 0
      if (z >= 2.2) delta = 2
      else if (z >= 1.2) delta = 1
      else if (z <= -2.2) delta = -2
      else if (z <= -1.2) delta = -1
      if (delta !== 0) deltaByPlayerId.set(s.id, delta)
    }
  }

  if (deltaByPlayerId.size === 0) return players

  return players.map((p) => {
    const delta = deltaByPlayerId.get(p.id)
    if (!delta) return p
    return {
      ...p,
      ratings: { ...p.ratings, potential: clampPotential(p.ratings.potential + delta, p.ratings.overall) },
    }
  })
}

export type SeasonGrade = 'A' | 'B' | 'C' | 'D' | 'F'

/**
 * A quick-glance letter grade for how a player's season went relative to
 * their position peers league-wide (every team, not just one roster) -
 * covers every position, not just the ones that feed potential above.
 * Players with no recorded stats that season (didn't play, e.g. injured
 * all year or a backup who never got in) get no grade.
 */
export function gradeSeasonPerformance(seasonStats: PlayerGameStats[]): Map<number, SeasonGrade> {
  const totals = aggregateSeasonStats(seasonStats)
  const positionByPlayer = new Map<number, Position>()
  for (const s of seasonStats) positionByPlayer.set(s.playerId, s.position)

  const grades = new Map<number, SeasonGrade>()

  for (const position of ALL_POSITIONS) {
    const scored = [...positionByPlayer.entries()]
      .filter(([, pos]) => pos === position)
      .map(([id]) => ({ id, score: productionScore(position, totals.get(id)!) }))
    if (scored.length < 3) continue

    const mean = scored.reduce((sum, s) => sum + s.score, 0) / scored.length
    const variance = scored.reduce((sum, s) => sum + (s.score - mean) ** 2, 0) / scored.length
    const stdev = Math.sqrt(variance)

    for (const s of scored) {
      const z = stdev > 0 ? (s.score - mean) / stdev : 0
      let grade: SeasonGrade
      if (z >= 1.2) grade = 'A'
      else if (z >= 0.4) grade = 'B'
      else if (z > -0.4) grade = 'C'
      else if (z > -1.2) grade = 'D'
      else grade = 'F'
      grades.set(s.id, grade)
    }
  }

  return grades
}
