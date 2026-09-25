import type { Player, Position } from '../types'
import { randInt, randNormal, type Rng } from './rng'

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
  // Passing
  passYards: number
  passTDs: number
  passAttempts: number
  passCompletions: number
  interceptions: number
  // Rushing/receiving
  rushYards: number
  rushTDs: number
  recYards: number
  recTDs: number
  receptions: number
  // Defense (DL/LB/CB/S)
  tackles: number
  sacks: number
  tacklesForLoss: number
  passBreakups: number
  defInterceptions: number
  yardsAllowed: number
  passerRatingAllowed: number
  // Offensive line
  pancakes: number
  sacksAllowed: number
  tflsAllowed: number
  // Kicking/punting
  fieldGoalsMade: number
  fieldGoalsAttempted: number
  longestFieldGoal: number
  extraPointsMade: number
  extraPointsAttempted: number
  puntCount: number
  puntYards: number
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
    tackles: 0,
    sacks: 0,
    tacklesForLoss: 0,
    passBreakups: 0,
    defInterceptions: 0,
    yardsAllowed: 0,
    passerRatingAllowed: 0,
    pancakes: 0,
    sacksAllowed: 0,
    tflsAllowed: 0,
    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    longestFieldGoal: 0,
    extraPointsMade: 0,
    extraPointsAttempted: 0,
    puntCount: 0,
    puntYards: 0,
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
 * A real backfield/receiving corps is not an even split by talent - the
 * starter gets the bulk of the touches every week, and depth guys only see
 * the field (and box score) some weeks, less often the further down the
 * depth chart they sit. Picks who plays this game and how big a slice of
 * the work they get, ranked by depth chart order (0 = starter).
 */
function activeWithShares(
  rng: Rng,
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

/** NFL-style passer rating (0-158.3), used for the "passer rating allowed" defensive stat. */
function passerRating(attempts: number, completions: number, yards: number, tds: number, ints: number) {
  if (attempts === 0) return 0
  const a = clamp01((completions / attempts - 0.3) * 5)
  const b = clamp01((yards / attempts - 3) * 0.25)
  const c = clamp01((tds / attempts) * 20)
  const d = clamp01(2.375 - (ints / attempts) * 25)
  return Math.round(((a + b + c + d) / 6) * 100 * 100) / 100
}

interface OffenseOutput {
  passAttempts: number
  passCompletions: number
  passYards: number
  passTDs: number
  interceptions: number
  rushYards: number
  rushTDs: number
  totalTDs: number
}

/**
 * Turns a team's final score into a plausible individual box score: total
 * yardage estimated from the score, split between passing/rushing, then
 * distributed among the roster's skill players weighted by overall (so a
 * team's best RB/WR sees more volume than the backups, without ever being
 * literally the whole offense).
 */
function generateOffenseBox(
  rng: Rng,
  roster: Player[],
  teamScore: number,
  box: Map<number, PlayerBoxScore>,
): OffenseOutput {
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
  const ol = roster.filter((p) => p.position === 'OL').sort(byDepth)

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

  let attempts = 0
  let completions = 0
  let interceptions = 0

  if (qb) {
    const stats = statsFor(qb)
    stats.passYards += passYards
    stats.passTDs += passTDs

    // Attempts scale with yardage; completion rate is driven by accuracy.
    attempts = Math.max(8, Math.round(passYards / 7.5 + randNormal(rng, 0, 3)))
    const completionRate = clamp01(0.63 + (qb.ratings.accuracy - 60) * 0.006)
    completions = Math.min(attempts, Math.max(0, Math.round(attempts * completionRate)))
    stats.passAttempts += attempts
    stats.passCompletions += completions

    // Bad decision-making means more picks; good decision-making means
    // fewer - roughly 0-3 interceptions per game at the extremes.
    const interceptionRate = clamp01((70 - qb.ratings.decisionMaking) * 0.006)
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

  const activeRbs = activeWithShares(rng, rbs, 1, 1, 0.6, 0.2, [0.68, 0.22, 0.08, 0.02])
  const activeReceivers = activeWithShares(
    rng,
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

  // Pancake blocks track with how well the run game went; every lineman who
  // suits up gets a share, weighted toward the starting five.
  if (ol.length > 0) {
    const activeOl = activeWithShares(rng, ol, 5, 2, 0.4, 0.15, [1, 1, 1, 1, 1, 0.5, 0.5])
    const pancakePool = Math.max(0, Math.round(rushYards / 12 + randNormal(rng, 0, 2)))
    for (const { player, share } of activeOl) {
      statsFor(player).pancakes += Math.round(pancakePool * share)
    }
  }

  return {
    passAttempts: attempts,
    passCompletions: completions,
    passYards,
    passTDs,
    interceptions,
    rushYards,
    rushTDs,
    totalTDs,
  }
}

/**
 * Credits the defense (DL/LB/CB/S) for the yardage/turnovers the opposing
 * offense just produced, and the offensive line for what it allowed -
 * derived from the opponent's box rather than simulated independently, so
 * a big defensive day always lines up with the offense it came against.
 */
function generateDefenseBox(
  rng: Rng,
  defenseRoster: Player[],
  offenseOl: Player[],
  opponent: OffenseOutput,
  defenseBox: Map<number, PlayerBoxScore>,
  offenseBox: Map<number, PlayerBoxScore>,
) {
  const statsFor = (box: Map<number, PlayerBoxScore>, p: Player) => {
    if (!box.has(p.id)) box.set(p.id, emptyBox(p.id, p.position))
    return box.get(p.id)!
  }

  const byDepth = (a: Player, b: Player) => a.depthOrder - b.depthOrder
  const front = defenseRoster.filter((p) => p.position === 'DL' || p.position === 'LB').sort(byDepth)
  const secondary = defenseRoster.filter((p) => p.position === 'CB' || p.position === 'S').sort(byDepth)

  const rushAttempts = Math.max(15, Math.round(opponent.rushYards / 4.3))
  const totalPlays = opponent.passAttempts + rushAttempts

  const frontStrength = teamStrength(defenseRoster, ['DL', 'LB'])
  const olStrength = teamStrength(offenseOl, ['OL'])
  const sackRate = clamp01(0.06 + (frontStrength - olStrength) * 0.0025)
  const sacks = Math.min(opponent.passAttempts, Math.round(opponent.passAttempts * sackRate))
  const tfls = Math.max(0, Math.round(rushAttempts * 0.06 + randNormal(rng, 0, 1)))

  const activeFront = activeWithShares(rng, front, 6, 3, 0.5, 0.15, [1, 1, 1, 1, 1, 1, 0.6, 0.6, 0.6])
  const frontWeight = (p: Player) => Math.pow(p.ratings.overall, 1.8)
  for (let i = 0; i < sacks; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeFront.map((a) => a.player), frontWeight)).sacks += 1
  }
  for (let i = 0; i < tfls; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeFront.map((a) => a.player), frontWeight)).tacklesForLoss += 1
  }

  const incompletions = Math.max(0, opponent.passAttempts - opponent.passCompletions - opponent.interceptions)
  const activeSecondary = activeWithShares(rng, secondary, 4, 2, 0.5, 0.2, [1, 1, 1, 1, 0.6, 0.6])
  const secondaryWeight = (p: Player) => Math.pow(p.ratings.overall, 1.8)

  // The offense's own thrown interceptions are the defense's takeaways.
  for (let i = 0; i < opponent.interceptions; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeSecondary.map((a) => a.player), secondaryWeight)).defInterceptions += 1
  }
  const passBreakups = Math.round(incompletions * 0.16)
  for (let i = 0; i < passBreakups; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeSecondary.map((a) => a.player), secondaryWeight)).passBreakups += 1
  }

  // Yards allowed and passer rating allowed are team-wide efficiency
  // numbers, credited to every active member of the secondary - a
  // simplification (no per-target coverage tracking yet), but it reflects
  // how well the pass defense as a whole is playing.
  const ratingAllowed = passerRating(
    opponent.passAttempts,
    opponent.passCompletions,
    opponent.passYards,
    opponent.passTDs,
    opponent.interceptions,
  )
  for (const { player } of activeSecondary) {
    const stats = statsFor(defenseBox, player)
    stats.yardsAllowed += Math.round(opponent.passYards / activeSecondary.length)
    stats.passerRatingAllowed = ratingAllowed
  }

  // Tackles: most go to the front seven (run plays + short completions),
  // the rest to the secondary (plays that get to open space).
  const frontTackles = Math.round(totalPlays * 0.62)
  const secondaryTackles = Math.round(totalPlays * 0.38)
  for (let i = 0; i < frontTackles; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeFront.map((a) => a.player), frontWeight)).tackles += 1
  }
  for (let i = 0; i < secondaryTackles; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeSecondary.map((a) => a.player), secondaryWeight)).tackles += 1
  }

  // Sacks/TFLs allowed mirror onto the offensive line that gave them up.
  if (offenseOl.length > 0) {
    const activeOl = activeWithShares(rng, offenseOl, 5, 2, 0.4, 0.15, [1, 1, 1, 1, 1, 0.5, 0.5])
    const olWeight = (p: Player) => 1 / Math.max(1, p.ratings.overall - 40)
    for (let i = 0; i < sacks; i++) {
      statsFor(offenseBox, pickWeighted(rng, activeOl.map((a) => a.player), olWeight)).sacksAllowed += 1
    }
    for (let i = 0; i < tfls; i++) {
      statsFor(offenseBox, pickWeighted(rng, activeOl.map((a) => a.player), olWeight)).tflsAllowed += 1
    }
  }
}

/** Kicking and punting box: field goals/PATs off the team's scoring, punts off how far short of a TD drive the rest of the game was. */
function generateSpecialTeamsBox(
  rng: Rng,
  roster: Player[],
  teamScore: number,
  offense: OffenseOutput,
  box: Map<number, PlayerBoxScore>,
) {
  const statsFor = (p: Player) => {
    if (!box.has(p.id)) box.set(p.id, emptyBox(p.id, p.position))
    return box.get(p.id)!
  }
  const byDepth = (a: Player, b: Player) => a.depthOrder - b.depthOrder

  const kicker = roster.filter((p) => p.position === 'K').sort(byDepth)[0]
  if (kicker) {
    const stats = statsFor(kicker)
    const tdPoints = offense.totalTDs * 7
    const remainingPoints = Math.max(0, teamScore - tdPoints)
    const fgMade = Math.round(remainingPoints / 3)
    const missChance = clamp01((80 - kicker.ratings.overall) * 0.01)
    const fgAttempted = fgMade + (rng() < missChance ? 1 : 0)
    stats.fieldGoalsMade += fgMade
    stats.fieldGoalsAttempted += fgAttempted
    if (fgMade > 0) {
      const legStrength = clamp01((kicker.ratings.overall - 50) / 50)
      stats.longestFieldGoal = Math.max(
        stats.longestFieldGoal,
        Math.round(32 + legStrength * 20 + rng() * 15),
      )
    }
    if (offense.totalTDs > 0) {
      const xpMissChance = clamp01((85 - kicker.ratings.overall) * 0.006)
      let xpMade = 0
      for (let i = 0; i < offense.totalTDs; i++) {
        if (rng() >= xpMissChance) xpMade++
      }
      stats.extraPointsAttempted += offense.totalTDs
      stats.extraPointsMade += xpMade
    }
  }

  const punter = roster.filter((p) => p.position === 'P').sort(byDepth)[0]
  if (punter) {
    const stats = statsFor(punter)
    // A stronger offense that scores more and picks up more total yardage
    // needs its punter less often.
    const offenseQuality = clamp01((teamScore - 10) / 30)
    const puntCount = Math.max(1, randInt(rng, 3, 6) - Math.round(offenseQuality * 2))
    const legStrength = clamp01((punter.ratings.overall - 50) / 50)
    let totalPuntYards = 0
    for (let i = 0; i < puntCount; i++) {
      totalPuntYards += Math.max(25, Math.round(38 + legStrength * 12 + randNormal(rng, 0, 6)))
    }
    stats.puntCount += puntCount
    stats.puntYards += totalPuntYards
  }
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

  const homeBox = new Map<number, PlayerBoxScore>()
  const awayBox = new Map<number, PlayerBoxScore>()

  const homeOffense = generateOffenseBox(rng, homeRoster, homeScore, homeBox)
  const awayOffense = generateOffenseBox(rng, awayRoster, awayScore, awayBox)

  const homeOl = homeRoster.filter((p) => p.position === 'OL')
  const awayOl = awayRoster.filter((p) => p.position === 'OL')

  // Away's defense faced home's offense, and vice versa.
  generateDefenseBox(rng, awayRoster, homeOl, homeOffense, awayBox, homeBox)
  generateDefenseBox(rng, homeRoster, awayOl, awayOffense, homeBox, awayBox)

  generateSpecialTeamsBox(rng, homeRoster, homeScore, homeOffense, homeBox)
  generateSpecialTeamsBox(rng, awayRoster, awayScore, awayOffense, awayBox)

  return { homeScore, awayScore, homeBox, awayBox }
}
