import type { Player, Position } from '../types'
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

export interface PlayerBoxScore {
  playerId: number
  position: Position
  passYards: number
  passTDs: number
  passAttempts: number
  passCompletions: number
  interceptions: number
  rushYards: number
  rushTDs: number
  recYards: number
  recTDs: number
  receptions: number
}

export interface SimResult {
  homeScore: number
  awayScore: number
  homeBox: Map<number, PlayerBoxScore>
  awayBox: Map<number, PlayerBoxScore>
}

function emptyBox(playerId: number, position: Position): PlayerBoxScore {
  return {
    playerId,
    position,
    passYards: 0,
    passTDs: 0,
    passAttempts: 0,
    passCompletions: 0,
    interceptions: 0,
    rushYards: 0,
    rushTDs: 0,
    recYards: 0,
    recTDs: 0,
    receptions: 0,
  }
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function pickWeighted<T>(rng: Rng, items: T[], weightFn: (item: T) => number): T {
  const weights = items.map(weightFn)
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return items[Math.floor(rng() * items.length)]
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

/**
 * Turns a team's final score into a plausible individual box score: total
 * yardage estimated from the score, split between passing/rushing, then
 * distributed among the roster's skill players weighted by overall (so a
 * team's best RB/WR sees more volume than the backups, without ever being
 * literally the whole offense).
 */
function generateBoxScore(rng: Rng, roster: Player[], teamScore: number): Map<number, PlayerBoxScore> {
  const box = new Map<number, PlayerBoxScore>()
  const statsFor = (p: Player) => {
    if (!box.has(p.id)) box.set(p.id, emptyBox(p.id, p.position))
    return box.get(p.id)!
  }

  // Depth chart order (0 = starter) decides who plays each position - this
  // respects a user's own manual depth chart reordering, and defaults to an
  // overall-based rank for AI teams that never touch it.
  const byDepth = (a: Player, b: Player) => a.depthOrder - b.depthOrder

  const qb = roster.filter((p) => p.position === 'QB').sort(byDepth)[0]
  const rbs = roster.filter((p) => p.position === 'RB').sort(byDepth)
  const receivers = roster.filter((p) => p.position === 'WR' || p.position === 'TE').sort(byDepth)

  const totalYards = Math.max(120, Math.round(teamScore * 13 + randNormal(rng, 0, 40)))
  const passShare = Math.min(0.8, Math.max(0.4, 0.6 + randNormal(rng, 0, 0.08)))
  const passYards = Math.round(totalYards * passShare)
  let rushYards = totalYards - passYards

  const totalTDs = Math.max(0, Math.round(teamScore / 7 + randNormal(rng, 0, 0.4)))
  let passTDs = 0
  let rushTDs = 0
  for (let i = 0; i < totalTDs; i++) {
    if (rng() < passShare * 0.85) passTDs++
    else rushTDs++
  }

  if (qb) {
    const stats = statsFor(qb)
    stats.passYards += passYards
    stats.passTDs += passTDs

    // Attempts scale with yardage; completion rate is driven by accuracy.
    const attempts = Math.max(8, Math.round(passYards / 7.5 + randNormal(rng, 0, 3)))
    const completionRate = clamp01(0.63 + (qb.ratings.accuracy - 60) * 0.006)
    const completions = Math.min(attempts, Math.max(0, Math.round(attempts * completionRate)))
    stats.passAttempts += attempts
    stats.passCompletions += completions

    // Bad decision-making means more picks; good decision-making means
    // fewer - roughly 0-3 interceptions per game at the extremes.
    const interceptionRate = clamp01((70 - qb.ratings.decisionMaking) * 0.006)
    let interceptions = 0
    for (let i = 0; i < attempts; i++) {
      if (rng() < interceptionRate / attempts) interceptions++
    }
    stats.interceptions += interceptions

    // Mobile, playmaking QBs pick up some scramble yardage of their own,
    // carved out of the team's rushing total rather than added on top.
    const scrambleShare = clamp01((qb.ratings.playmaking - 55) / 130)
    const qbRushYards = Math.max(0, Math.round(rushYards * scrambleShare * 0.35))
    if (qbRushYards > 0) {
      stats.rushYards += qbRushYards
      rushYards -= qbRushYards
    }
  }

  // A real backfield/receiving corps is not an even split by talent - the
  // starter gets the bulk of the touches every week, and depth guys only
  // see the field (and box score) some weeks, less often the further down
  // the depth chart they sit. `activeWithShares` picks who plays this game
  // and how big a slice of the work they get, ranked by overall.
  function activeWithShares(
    players: Player[],
    alwaysActive: number,
    partialCount: number,
    partialChance: number,
    deepChance: number,
    shares: number[],
  ): { player: Player; share: number }[] {
    const active = players.filter((_, i) => {
      if (i < alwaysActive) return true
      if (i < alwaysActive + partialCount) return rng() < partialChance
      return rng() < deepChance
    })
    const rawShares = active.map((_, i) => shares[i] ?? shares[shares.length - 1] * 0.5)
    const total = rawShares.reduce((a, b) => a + b, 0) || 1
    return active.map((player, i) => ({ player, share: rawShares[i] / total }))
  }

  const activeRbs = activeWithShares(rbs, 1, 1, 0.6, 0.2, [0.68, 0.22, 0.08, 0.02])
  const activeReceivers = activeWithShares(
    receivers,
    3,
    2,
    0.55,
    0.2,
    [0.3, 0.22, 0.16, 0.12, 0.1, 0.06, 0.04],
  )

  if (activeRbs.length > 0) {
    for (const { player, share } of activeRbs) {
      statsFor(player).rushYards += Math.round(rushYards * share)
    }
    const weight = (p: Player) => Math.pow(p.ratings.overall, 2.2)
    for (let i = 0; i < rushTDs; i++) {
      statsFor(pickWeighted(rng, activeRbs.map((a) => a.player), weight)).rushTDs += 1
    }
  }

  if (activeReceivers.length > 0) {
    for (const { player, share } of activeReceivers) {
      const yards = Math.round(passYards * share)
      const stats = statsFor(player)
      stats.recYards += yards
      stats.receptions += Math.max(yards > 0 ? 1 : 0, Math.round(yards / 12))
    }
    const weight = (p: Player) => Math.pow(p.ratings.overall, 2.2)
    for (let i = 0; i < passTDs; i++) {
      statsFor(pickWeighted(rng, activeReceivers.map((a) => a.player), weight)).recTDs += 1
    }
  }

  return box
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

  let homeScore = Math.max(0, Math.round(randNormal(rng, homeExpected, 8)))
  let awayScore = Math.max(0, Math.round(randNormal(rng, awayExpected, 8)))

  // Real NFL ties are rare (~0.1-0.2% of games); ours were landing far more
  // often since two independent normal draws collide more than that. Send
  // any regulation tie to a short overtime and force a winner, same as the
  // real league effectively does outside the handful of true double-OT ties.
  if (homeScore === awayScore) {
    const otEdge = (homeOff - awayDef - (awayOff - homeDef)) * 0.01
    const homeWinsOT = rng() < 0.5 + otEdge
    const otPoints = rng() < 0.15 ? 3 : rng() < 0.5 ? 6 : 7 // FG, or a TD (2pt fails sometimes)
    if (homeWinsOT) homeScore += otPoints
    else awayScore += otPoints
  }

  const homeBox = generateBoxScore(rng, homeRoster, homeScore)
  const awayBox = generateBoxScore(rng, awayRoster, awayScore)

  return { homeScore, awayScore, homeBox, awayBox }
}
