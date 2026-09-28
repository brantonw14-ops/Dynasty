import type { Player, PlayerGameStats, Position } from '../types'
import { aggregateSeasonStats, productionScore } from './seasonPerformance'

export type AwardCategory = 'mvp' | 'opoy' | 'dpoy' | 'oroy' | 'droy' | 'probowl'

/**
 * One award/honor a player received at the end of a specific season.
 * Snapshotted (name/position/teamId/overall) rather than joined live against
 * `players`, since a retired player is deleted outright - without a
 * snapshot, an MVP from 3 seasons ago who's since retired would vanish from
 * their own award history.
 */
export interface SeasonAward {
  id: number
  leagueId: number
  season: number
  category: AwardCategory
  // 1-5 for mvp/opoy/dpoy/oroy/droy (award rank, 1 = winner). Pro Bowl
  // selections aren't ranked against each other, so they're always 0.
  rank: number
  playerId: number
  playerName: string
  position: Position
  teamId: number | null
  overall: number
}

const OFFENSE_SKILL_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE']
const DEFENSE_POSITIONS: Position[] = ['DL', 'LB', 'CB', 'S']
const MVP_ELIGIBLE_POSITIONS: Position[] = [...OFFENSE_SKILL_POSITIONS, ...DEFENSE_POSITIONS]

/** How many Pro Bowl selections to hand out per position - roughly matches a real conference squad's depth. */
const PRO_BOWL_COUNTS: Partial<Record<Position, number>> = {
  QB: 3,
  RB: 4,
  WR: 5,
  TE: 2,
  OL: 5,
  DL: 4,
  LB: 5,
  CB: 4,
  S: 3,
  K: 1,
  P: 1,
}

interface ScoredPlayer {
  player: Player
  z: number
  score: number
}

/**
 * Ranks each player against their own position's peers and expresses it as
 * a percentile in [0, 1] (1 = the best at that position), so positions with
 * very different stat shapes can be compared fairly. A z-score was tried
 * first, but defensive counting stats (sacks, INTs) are lumpy/skewed with
 * small samples and threw off wildly larger z-spikes than smooth stats like
 * passing yards - that let defense sweep every MVP slot every season. A
 * bounded percentile can't blow up like that: at most one player per
 * position can ever sit at the top. `z` on the returned rows is only a
 * secondary field kept for tie-breaking players with the same percentile.
 */
function percentileByPosition(
  players: Player[],
  stats: PlayerGameStats[],
  positions: Position[],
): ScoredPlayer[] {
  const totals = aggregateSeasonStats(stats)
  const results: ScoredPlayer[] = []

  for (const position of positions) {
    const group = players.filter((p) => p.position === position && totals.has(p.id))
    if (group.length < 3) continue

    const scored = group
      .map((p) => ({ player: p, score: productionScore(position, totals.get(p.id)!) }))
      .sort((a, b) => a.score - b.score)
    const n = scored.length

    scored.forEach((s, i) => {
      const percentile = n > 1 ? i / (n - 1) : 1
      results.push({ player: s.player, z: percentile, score: s.score })
    })
  }

  return results.sort((a, b) => b.z - a.z || b.score - a.score)
}

/**
 * Keeps at most `cap` finalists per position from an already-sorted (best
 * first) field. Without this, mixing z-scores across positions with very
 * different stat shapes (e.g. sacks are rare and lumpy, passing yards are
 * smooth with a huge sample) lets one position's whole depth chart flood
 * every slot of a cross-position award like MVP - a real MVP/DPOY race
 * should have a mix of positions among the finalists, not the top 5
 * pass-rushers in the league every single year.
 */
function capPerPosition(field: ScoredPlayer[], cap: number): ScoredPlayer[] {
  const taken = new Map<Position, number>()
  const kept: ScoredPlayer[] = []
  for (const s of field) {
    const n = taken.get(s.player.position) ?? 0
    if (n >= cap) continue
    taken.set(s.player.position, n + 1)
    kept.push(s)
  }
  return kept
}

function toAward(leagueId: number, season: number, category: AwardCategory, rank: number, p: Player): Omit<SeasonAward, 'id'> {
  return {
    leagueId,
    season,
    category,
    rank,
    playerId: p.id,
    playerName: `${p.firstName} ${p.lastName}`,
    position: p.position,
    teamId: p.teamId,
    overall: p.ratings.overall,
  }
}

/**
 * Computes every end-of-season award (MVP/OPOY/DPOY/OROY/DROY, top 5 each)
 * plus Pro Bowl selections, from one season's box scores. Pure and
 * synchronous - callers are responsible for persisting the result (see
 * `finalizeSeasonAwards` in league.ts) and for calling this before a
 * player's `experience` gets incremented for the *next* season (rookie
 * awards rely on `experience === 0` meaning "played their first season this
 * year").
 */
export function computeSeasonAwards(
  leagueId: number,
  season: number,
  players: Player[],
  seasonStats: PlayerGameStats[],
): Omit<SeasonAward, 'id'>[] {
  const awards: Omit<SeasonAward, 'id'>[] = []

  const pushRanked = (category: AwardCategory, field: ScoredPlayer[]) => {
    field.slice(0, 5).forEach((s, i) => awards.push(toAward(leagueId, season, category, i + 1, s.player)))
  }

  // Capped at 2 per position so MVP/DPOY finalists are a realistic mix of
  // positions, not a single position's whole leaderboard.
  const mvpField = capPerPosition(percentileByPosition(players, seasonStats, MVP_ELIGIBLE_POSITIONS), 2)
  pushRanked('mvp', mvpField)

  const opoyField = capPerPosition(percentileByPosition(players, seasonStats, OFFENSE_SKILL_POSITIONS), 2)
  pushRanked('opoy', opoyField)

  const dpoyField = capPerPosition(percentileByPosition(players, seasonStats, DEFENSE_POSITIONS), 2)
  pushRanked('dpoy', dpoyField)

  const rookieField = (field: ScoredPlayer[]) => field.filter((s) => (s.player.experience ?? 0) === 0)
  pushRanked('oroy', rookieField(percentileByPosition(players, seasonStats, OFFENSE_SKILL_POSITIONS)))
  pushRanked('droy', rookieField(percentileByPosition(players, seasonStats, DEFENSE_POSITIONS)))

  const proBowlField = percentileByPosition(players, seasonStats, Object.keys(PRO_BOWL_COUNTS) as Position[])
  const proBowlCountTaken = new Map<Position, number>()
  for (const s of proBowlField) {
    const cap = PRO_BOWL_COUNTS[s.player.position] ?? 0
    const taken = proBowlCountTaken.get(s.player.position) ?? 0
    if (taken >= cap) continue
    proBowlCountTaken.set(s.player.position, taken + 1)
    awards.push(toAward(leagueId, season, 'probowl', 0, s.player))
  }

  return awards
}
