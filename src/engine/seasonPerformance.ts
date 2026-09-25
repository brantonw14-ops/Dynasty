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
}

function emptyTotals(): StatTotals {
  return { passYards: 0, passTDs: 0, interceptions: 0, rushYards: 0, rushTDs: 0, recYards: 0, recTDs: 0 }
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
    totals.set(s.playerId, t)
  }
  return totals
}

/** Only positions with production stats worth judging a season by. */
const SCORED_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE']

function productionScore(position: Position, t: StatTotals): number {
  switch (position) {
    case 'QB':
      return t.passYards + t.passTDs * 20 - t.interceptions * 15 + t.rushYards * 0.5
    case 'RB':
      return t.rushYards + t.recYards * 0.5 + (t.rushTDs + t.recTDs) * 20
    case 'WR':
    case 'TE':
      return t.recYards + t.recTDs * 20
    default:
      return 0
  }
}

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
