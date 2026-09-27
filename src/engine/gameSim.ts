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
  rushAttempts: number
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
    rushAttempts: 0,
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
 *
 * The base `shares` array only encodes depth-slot pecking order (RB1 gets
 * more than RB2 regardless of how good either one is). `talentPow` lets a
 * genuine talent gap move volume on top of that: each player's slot share
 * is scaled by their own overall raised to this power before normalizing,
 * so an elite starter with a weak backup pulls even further ahead of the
 * fixed split, and a mediocre "starter" doesn't automatically outproduce a
 * clearly better backup. 0 disables this (pure slot-based split).
 */
function activeWithShares(
  rng: Rng,
  players: Player[],
  alwaysActive: number,
  partialCount: number,
  partialChance: number,
  deepChance: number,
  shares: number[],
  talentPow = 0,
): { player: Player; share: number }[] {
  const active = players.filter((_, i) => {
    if (i < alwaysActive) return true
    if (i < alwaysActive + partialCount) return rng() < partialChance
    return rng() < deepChance
  })
  const rawShares = active.map((p, i) => {
    const base = shares[i] ?? shares[shares.length - 1] * 0.5
    return talentPow > 0 ? base * Math.pow(Math.max(30, p.ratings.overall), talentPow) : base
  })
  const total = rawShares.reduce((a, b) => a + b, 0) || 1
  return active.map((player, i) => ({ player, share: rawShares[i] / total }))
}

/**
 * The real NFL passer rating formula (0-158.3): each of the four
 * components is clamped to [0, 2.375] individually before being averaged
 * and scaled by 100. Used both for a QB's own season rating and for the
 * "passer rating allowed" defensive stat.
 */
export function passerRating(attempts: number, completions: number, yards: number, tds: number, ints: number) {
  if (attempts === 0) return 0
  const clampComponent = (n: number) => Math.max(0, Math.min(2.375, n))
  const a = clampComponent((completions / attempts - 0.3) * 5)
  const b = clampComponent((yards / attempts - 3) * 0.25)
  const c = clampComponent((tds / attempts) * 20)
  const d = clampComponent(2.375 - (ints / attempts) * 25)
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

const OFFENSE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'OL']
const DEFENSE_POSITIONS = ['DL', 'LB', 'CB', 'S']

/**
 * The final score for a team, decided *before* any yardage/box stats are
 * generated: how many touchdowns and field goals actually happened, and
 * whether the kicker made each PAT/FG. Everything else (yardage, who got
 * the ball) is flavor built around these already-decided scoring plays, so
 * the final score is always exactly tds*6 + patMade + fgMade*3 - it can
 * never drift from what the box score itself shows, the way an
 * independently-rolled team score used to (a QB's 2 TDs + a "perfect"
 * kicker not necessarily summing to the displayed score).
 */
interface ScoringPlan {
  tds: number
  passTDs: number
  rushTDs: number
  passShare: number
  fgAttempted: number
  fgMade: number
  longestFieldGoal: number
  patAttempted: number
  patMade: number
  score: number
}

function decideScoringPlan(rng: Rng, offRoster: Player[], defRoster: Player[], homeFieldEdge: number): ScoringPlan {
  const offRating = teamStrength(offRoster, OFFENSE_POSITIONS)
  const defRating = teamStrength(defRoster, DEFENSE_POSITIONS)
  const diff = offRating - defRating + homeFieldEdge

  // Real NFL teams combine for roughly 2.5 TDs and 1.7 FGs a game - a real
  // talent gap shifts both how many scoring chances a team gets and how
  // many of those chances turn into a TD instead of a field goal.
  const expectedTds = Math.max(0.2, 2.35 + diff * 0.045)
  const tds = Math.max(0, Math.round(randNormal(rng, expectedTds, Math.sqrt(expectedTds))))
  const expectedFgTries = Math.max(0.1, 1.7 - diff * 0.015)
  const fgAttempted = Math.max(0, Math.round(randNormal(rng, expectedFgTries, Math.sqrt(expectedFgTries))))

  const passShare = Math.min(0.85, Math.max(0.45, 0.665 + randNormal(rng, 0, 0.07)))
  let passTDs = 0
  let rushTDs = 0
  for (let i = 0; i < tds; i++) {
    if (rng() < passShare * 0.85) passTDs++
    else rushTDs++
  }

  // K attributes: attr1=Kick Accuracy, attr2=Kick Power, attr3=Clutch Gene.
  const kicker = offRoster.filter((p) => p.position === 'K').sort((a, b) => a.depthOrder - b.depthOrder)[0]
  const clutchDiscount = kicker ? (kicker.ratings.attr3 - 60) * 0.003 : 0
  const fgMissChance = kicker ? clamp01((80 - kicker.ratings.attr1) * 0.01 - clutchDiscount) : 0.15
  const patMissChance = kicker ? clamp01((85 - kicker.ratings.attr1) * 0.006 - clutchDiscount) : 0.05
  const legStrength = kicker ? clamp01((kicker.ratings.attr2 - 50) / 50) : 0.5

  let fgMade = 0
  let longestFieldGoal = 0
  for (let i = 0; i < fgAttempted; i++) {
    if (rng() >= fgMissChance) {
      fgMade++
      longestFieldGoal = Math.max(longestFieldGoal, Math.round(32 + legStrength * 20 + rng() * 15))
    }
  }

  let patMade = 0
  for (let i = 0; i < tds; i++) {
    if (rng() >= patMissChance) patMade++
  }

  return {
    tds,
    passTDs,
    rushTDs,
    passShare,
    fgAttempted,
    fgMade,
    longestFieldGoal,
    patAttempted: tds,
    patMade,
    score: tds * 6 + patMade + fgMade * 3,
  }
}

/**
 * Turns an already-decided scoring plan into a plausible individual box
 * score: total yardage estimated from the resulting score, split between
 * passing/rushing, then distributed among the roster's skill players
 * weighted by overall (so a team's best RB/WR sees more volume than the
 * backups, without ever being literally the whole offense). The TD count
 * itself (and its pass/rush split) comes straight from the plan, not a
 * second independent estimate, so it can never disagree with the score.
 */
function generateOffenseBox(
  rng: Rng,
  roster: Player[],
  plan: ScoringPlan,
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

  // Calibrated against real 2024 NFL per-team-per-game averages: ~337 total
  // yards, ~224 passing / ~113 rushing, ~21.8 points - so totalYards tracks
  // team quality (via the already-decided score) but keeps a real floor
  // even on a bad day, instead of collapsing toward zero.
  const totalYards = Math.max(180, Math.round(206 + plan.score * 6 + randNormal(rng, 0, 45)))
  const passShare = plan.passShare
  const passYards = Math.round(totalYards * passShare)
  let rushYards = totalYards - passYards

  const totalTDs = plan.tds
  const passTDs = plan.passTDs
  const rushTDs = plan.rushTDs

  let attempts = 0
  let completions = 0
  let interceptions = 0

  if (qb) {
    const stats = statsFor(qb)
    stats.passYards += passYards
    stats.passTDs += passTDs

    // QB attributes: attr1=Accuracy, attr2=Decision Making, attr3=Playmaking.
    // Attempts scale with yardage at a real ~6.8 yards/attempt clip (NFL
    // average), so a normal game lands around 30-35 attempts instead of
    // the high-teens a too-generous per-attempt figure produced before.
    // Completion rate also reflects the receivers a QB is throwing to - a
    // great arm still needs someone to catch the ball.
    attempts = Math.max(18, Math.round(passYards / 6.8 + randNormal(rng, 0, 3)))
    const receiverStrength = teamStrength(roster, ['WR', 'TE'])
    const completionRate = clamp01(
      0.63 + (qb.ratings.attr1 - 68) * 0.005 + (receiverStrength - 68) * 0.003,
    )
    completions = Math.min(attempts, Math.max(0, Math.round(attempts * completionRate)))
    stats.passAttempts += attempts
    stats.passCompletions += completions

    // Bad decision-making means more picks; good decision-making means
    // fewer, but even a great decision-maker throws the occasional pick -
    // roughly a floor of 0.5% of attempts up toward ~10% for a truly poor one.
    const interceptionRate = Math.max(0.005, clamp01((75 - qb.ratings.attr2) * 0.0032))
    for (let i = 0; i < attempts; i++) {
      if (rng() < interceptionRate) interceptions++
    }
    stats.interceptions += interceptions

    // Mobile, playmaking QBs pick up some scramble yardage of their own,
    // carved out of the team's rushing total rather than added on top.
    const scrambleShare = clamp01((qb.ratings.attr3 - 55) / 130)
    const qbRushYards = Math.max(0, Math.round(rushYards * scrambleShare * 0.35))
    if (qbRushYards > 0) {
      stats.rushYards += qbRushYards
      stats.rushAttempts += Math.max(1, Math.round(qbRushYards / 6.5))
      rushYards -= qbRushYards
    }
  }

  // RB3/RB4 are emergency-only in a real NFL game - they basically don't see
  // the field unless the backfield ahead of them is thinned by injury, which
  // a near-zero deepChance approximates (some noise for legitimate blowout
  // garbage-time snaps, not a real rotation).
  const activeRbs = activeWithShares(rng, rbs, 1, 1, 0.6, 0.03, [0.68, 0.22, 0.08, 0.02], 1.6)
  const activeReceivers = activeWithShares(
    rng,
    receivers,
    3,
    2,
    0.55,
    0.2,
    [0.3, 0.22, 0.16, 0.12, 0.1, 0.06, 0.04],
    1.6,
  )

  if (activeRbs.length > 0) {
    // Yards per carry averages a bit below 4.3 in the real NFL, but a run
    // game is a team effort - a strong offensive line pushes it up, a weak
    // one drags it down, on top of game-to-game noise.
    const olStrength = teamStrength(ol, ['OL'])
    const yardsPerCarry = Math.max(2.5, 4.2 + (olStrength - 68) * 0.035 + randNormal(rng, 0, 0.5))
    const teamRushAttempts = Math.max(8, Math.round(rushYards / yardsPerCarry))
    for (const { player, share } of activeRbs) {
      const stats = statsFor(player)
      stats.rushYards += Math.round(rushYards * share)
      stats.rushAttempts += Math.max(1, Math.round(teamRushAttempts * share))
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

  // A real offensive line doesn't rotate - the same 5 starters play every
  // offensive snap unless one gets hurt during the game (handled by the
  // separate in-game injury system, not this box-score sim), so exactly the
  // top 5 by depth chart get pancake credit, nobody else.
  if (ol.length > 0) {
    const activeOl = activeWithShares(rng, ol, 5, 0, 0, 0, [1, 1, 1, 1, 1], 1.3)
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

  // Front-7 starters (top 7 by depth chart) are on the field for the bulk of
  // defensive snaps in a real game; rotational depth sees the field less
  // often, and the deepest bodies on the roster barely at all.
  const activeFront = activeWithShares(rng, front, 7, 2, 0.4, 0.1, [1, 1, 1, 1, 1, 1, 1, 0.5, 0.5])
  const frontWeight = (p: Player) => Math.pow(p.ratings.overall, 1.8)
  for (let i = 0; i < sacks; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeFront.map((a) => a.player), frontWeight)).sacks += 1
  }
  for (let i = 0; i < tfls; i++) {
    statsFor(defenseBox, pickWeighted(rng, activeFront.map((a) => a.player), frontWeight)).tacklesForLoss += 1
  }

  const incompletions = Math.max(0, opponent.passAttempts - opponent.passCompletions - opponent.interceptions)
  // Same idea in the secondary - the starting 4 (2 CB, 2 S) are out there
  // for most snaps, with a nickel/dime piece rotating in less often.
  const activeSecondary = activeWithShares(rng, secondary, 4, 1, 0.45, 0.1, [1, 1, 1, 1, 0.5, 0.5])
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
  // numbers (no per-target coverage tracking - which receiver each guy
  // covered on which play - modeled yet), but they shouldn't be handed out
  // identically to the whole secondary either: a real box score has a
  // shutdown corner posting a great number while the weak link across from
  // him gets picked on. Weight each player's share by their own coverage
  // skill (Man + Zone Coverage) relative to the group's average, so the
  // better cover guys show better numbers and the worse ones show worse.
  const ratingAllowed = passerRating(
    opponent.passAttempts,
    opponent.passCompletions,
    opponent.passYards,
    opponent.passTDs,
    opponent.interceptions,
  )
  const coverageSkill = (p: Player) => (p.ratings.attr2 + p.ratings.attr3) / 2
  const skills = activeSecondary.map(({ player }) => coverageSkill(player))
  const avgSkill = skills.length > 0 ? skills.reduce((s, v) => s + v, 0) / skills.length : 60
  // A weaker-than-average defender takes a bigger slice of the yardage and
  // a worse (higher) rating allowed; a shutdown corner takes less of both.
  const weights = skills.map((sk) => avgSkill / Math.max(30, sk))
  const totalWeight = weights.reduce((s, v) => s + v, 0) || 1
  activeSecondary.forEach(({ player }, i) => {
    const stats = statsFor(defenseBox, player)
    const share = weights[i] / totalWeight
    stats.yardsAllowed += Math.round(opponent.passYards * share)
    const relativeWeakness = avgSkill / Math.max(30, skills[i])
    stats.passerRatingAllowed = Math.min(158.3, Math.max(0, ratingAllowed * relativeWeakness))
  })

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

  // Sacks/TFLs allowed mirror onto the offensive line that gave them up -
  // same top-5-only, no-rotation logic as the pancakes side.
  if (offenseOl.length > 0) {
    const activeOl = activeWithShares(rng, offenseOl, 5, 0, 0, 0, [1, 1, 1, 1, 1])
    const olWeight = (p: Player) => 1 / Math.max(1, p.ratings.overall - 40)
    for (let i = 0; i < sacks; i++) {
      statsFor(offenseBox, pickWeighted(rng, activeOl.map((a) => a.player), olWeight)).sacksAllowed += 1
    }
    for (let i = 0; i < tfls; i++) {
      statsFor(offenseBox, pickWeighted(rng, activeOl.map((a) => a.player), olWeight)).tflsAllowed += 1
    }
  }
}

/**
 * Kicking and punting box: field goals/PATs are just recorded straight off
 * the already-decided scoring plan (no second dice roll here - that used
 * to be where the score/box-stat mismatch crept in), punts off how far
 * short of a TD drive the rest of the game was.
 */
function generateSpecialTeamsBox(rng: Rng, roster: Player[], plan: ScoringPlan, box: Map<number, PlayerBoxScore>) {
  const statsFor = (p: Player) => {
    if (!box.has(p.id)) box.set(p.id, emptyBox(p.id, p.position))
    return box.get(p.id)!
  }
  const byDepth = (a: Player, b: Player) => a.depthOrder - b.depthOrder

  const kicker = roster.filter((p) => p.position === 'K').sort(byDepth)[0]
  if (kicker) {
    const stats = statsFor(kicker)
    stats.fieldGoalsMade += plan.fgMade
    stats.fieldGoalsAttempted += plan.fgAttempted
    stats.longestFieldGoal = Math.max(stats.longestFieldGoal, plan.longestFieldGoal)
    stats.extraPointsAttempted += plan.patAttempted
    stats.extraPointsMade += plan.patMade
  }

  const punter = roster.filter((p) => p.position === 'P').sort(byDepth)[0]
  if (punter) {
    const stats = statsFor(punter)
    // A stronger offense that scores more and picks up more total yardage
    // needs its punter less often.
    const offenseQuality = clamp01((plan.score - 10) / 30)
    const puntCount = Math.max(1, randInt(rng, 3, 6) - Math.round(offenseQuality * 2))
    const legStrength = clamp01((punter.ratings.attr2 - 50) / 50)
    let totalPuntYards = 0
    for (let i = 0; i < puntCount; i++) {
      totalPuntYards += Math.max(25, Math.round(38 + legStrength * 12 + randNormal(rng, 0, 6)))
    }
    stats.puntCount += puntCount
    stats.puntYards += totalPuntYards
  }
}

/** Adds one more authoritative scoring play (a made FG, or a TD+PAT try) onto a plan - used to break a regulation tie in a short OT. */
function addOvertimeScore(rng: Rng, roster: Player[], plan: ScoringPlan) {
  const kicker = roster.filter((p) => p.position === 'K').sort((a, b) => a.depthOrder - b.depthOrder)[0]
  const clutchDiscount = kicker ? (kicker.ratings.attr3 - 60) * 0.003 : 0
  if (rng() < 0.55) {
    plan.fgAttempted += 1
    plan.fgMade += 1
    plan.score += 3
    if (kicker) {
      const legStrength = clamp01((kicker.ratings.attr2 - 50) / 50)
      plan.longestFieldGoal = Math.max(plan.longestFieldGoal, Math.round(32 + legStrength * 20 + rng() * 15))
    }
    return
  }
  plan.tds += 1
  if (rng() < plan.passShare * 0.85) plan.passTDs += 1
  else plan.rushTDs += 1
  plan.patAttempted += 1
  const patMissChance = kicker ? clamp01((85 - kicker.ratings.attr1) * 0.006 - clutchDiscount) : 0.05
  if (rng() >= patMissChance) {
    plan.patMade += 1
    plan.score += 7
  } else {
    plan.score += 6
  }
}

export function simGame(rng: Rng, homeRoster: Player[], awayRoster: Player[]): SimResult {
  const homePlan = decideScoringPlan(rng, homeRoster, awayRoster, 2) // home-field edge
  const awayPlan = decideScoringPlan(rng, awayRoster, homeRoster, 0)

  // Real NFL ties are rare (~0.1-0.2% of games); ours were landing far more
  // often since two independently-decided scores collide more than that.
  // Send any regulation tie to a short overtime and force a winner, same
  // as the real league effectively does outside a handful of true double-OT
  // ties - the extra score is added onto the winner's plan (not bolted on
  // separately) so the final score always still matches that team's box.
  if (homePlan.score === awayPlan.score) {
    const homeOff = teamStrength(homeRoster, OFFENSE_POSITIONS)
    const homeDef = teamStrength(homeRoster, DEFENSE_POSITIONS)
    const awayOff = teamStrength(awayRoster, OFFENSE_POSITIONS)
    const awayDef = teamStrength(awayRoster, DEFENSE_POSITIONS)
    const otEdge = (homeOff - awayDef - (awayOff - homeDef)) * 0.01
    const homeWinsOT = rng() < 0.5 + otEdge
    addOvertimeScore(rng, homeWinsOT ? homeRoster : awayRoster, homeWinsOT ? homePlan : awayPlan)
  }

  const homeScore = homePlan.score
  const awayScore = awayPlan.score

  const homeBox = new Map<number, PlayerBoxScore>()
  const awayBox = new Map<number, PlayerBoxScore>()

  const homeOffense = generateOffenseBox(rng, homeRoster, homePlan, homeBox)
  const awayOffense = generateOffenseBox(rng, awayRoster, awayPlan, awayBox)

  const homeOl = homeRoster.filter((p) => p.position === 'OL')
  const awayOl = awayRoster.filter((p) => p.position === 'OL')

  // Away's defense faced home's offense, and vice versa.
  generateDefenseBox(rng, awayRoster, homeOl, homeOffense, awayBox, homeBox)
  generateDefenseBox(rng, homeRoster, awayOl, awayOffense, homeBox, awayBox)

  generateSpecialTeamsBox(rng, homeRoster, homePlan, homeBox)
  generateSpecialTeamsBox(rng, awayRoster, awayPlan, awayBox)

  return { homeScore, awayScore, homeBox, awayBox }
}
