import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from './db'
import {
  acceptTradeOffer,
  advanceToFreeAgency,
  autoFillRoster,
  beginDraft,
  createLeague,
  cutPlayer,
  deleteLeague,
  estimateFreeAgentAsk,
  findSuggestedTrades,
  getDraftBoard,
  getSeasonHistory,
  makeUserDraftPick,
  moveDepthChart,
  optimizeDepthChart,
  openFreeAgency,
  ownedPicks,
  previewLeagueTeams,
  proposeTrade,
  removeTradeOffer,
  resignPlayer,
  signFreeAgent,
  simRestOfDraft,
  simWeek,
  toggleTradeBlock,
  type SuggestedTrade,
  type TeamPreview,
} from './engine/league'
import { computeCapSpace } from './engine/freeAgency'
import { buildGameReasons, classifyGamePerformance, performanceBlurb } from './engine/gameReport'
import {
  computePositionOverall,
  computeTeamOverall,
  MIN_ROSTER_SIZE,
  POSITION_ATTRIBUTES,
  rosterNeeds,
  STARTER_COUNTS,
} from './engine/players'
import { passerRating } from './engine/gameSim'
import { marketSalary } from './engine/salary'
import { gradeSeasonPerformance, type SeasonGrade } from './engine/seasonPerformance'
import { computeConferenceSeeds, computeStandings } from './engine/standings'
import { pickValue } from './engine/trades'
import type {
  Conference,
  Division,
  GameResult,
  LeaguePhase,
  PendingTradeOffer,
  Player,
  PlayerGameStats,
  PlayoffRound,
  Position,
  Team,
  TradePickRef,
} from './types'

const GRADE_COLORS: Record<SeasonGrade, string> = {
  A: 'text-green-400',
  B: 'text-emerald-300',
  C: 'text-gray-300',
  D: 'text-orange-400',
  F: 'text-red-400',
}

const OUTLOOK_LABELS: Record<TeamPreview['outlook'], string> = {
  rebuilding: 'Rebuilding',
  contender: 'Playoff Contender',
  superbowl: 'Super Bowl Worthy',
}
const OUTLOOK_STYLES: Record<TeamPreview['outlook'], string> = {
  rebuilding: 'bg-slate-700 text-slate-200',
  contender: 'bg-blue-900 text-blue-200',
  superbowl: 'bg-amber-900 text-amber-200',
}

const POSITION_ORDER: Position[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P']
const CONFERENCES: Conference[] = ['AFC', 'NFC']
const DIVISIONS: Division[] = ['East', 'North', 'South', 'West']
const ROUND_LABELS: Record<PlayoffRound, string> = {
  wildcard: 'Wild Card',
  divisional: 'Divisional',
  conference: 'Conference Championship',
  superbowl: 'Super Bowl',
}
const ROUND_ORDER: PlayoffRound[] = ['wildcard', 'divisional', 'conference', 'superbowl']

interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

/** Sortable <th>: click to sort by this column, click again to flip direction. */
function SortHeader({
  label,
  sortKey,
  sort,
  setSort,
  className = '',
}: {
  label: string
  sortKey: string
  sort: SortState
  setSort: (s: SortState) => void
  className?: string
}) {
  const active = sort.key === sortKey
  return (
    <th
      className={`py-1 cursor-pointer select-none hover:text-gray-200 ${className}`}
      onClick={() => setSort({ key: sortKey, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
    >
      {label}
      {active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}
    </th>
  )
}

/**
 * A "how strong is each position on my team" grid, click a tile to expand
 * it and see/cut individual players - shared by the Free Agency and Draft
 * screens so a user can see what they need and make room for it (by
 * cutting someone) without leaving to the Roster screen. Clicking a tile
 * also reports the selection up via `onSelectPosition`, so the caller can
 * filter its own available-players list down to just that position.
 */
function TeamPositionPanel({
  roster,
  leagueId,
  needs,
  onSelectPosition,
}: {
  roster: Player[]
  leagueId: number
  needs: Position[]
  onSelectPosition?: (pos: Position | null) => void
}) {
  const [expanded, setExpandedState] = useState<Position | null>(null)
  const [cuttingId, setCuttingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const setExpanded = (pos: Position | null) => {
    setExpandedState(pos)
    onSelectPosition?.(pos)
  }

  const byPosition = new Map<Position, Player[]>()
  for (const p of roster) {
    const list = byPosition.get(p.position) ?? []
    list.push(p)
    byPosition.set(p.position, list)
  }
  const summary = POSITION_ORDER.map((pos) => {
    const group = (byPosition.get(pos) ?? []).sort((a, b) => b.ratings.overall - a.ratings.overall)
    return {
      pos,
      group,
      positionOverall: group.length > 0 ? Math.round(computePositionOverall(group)) : 0,
      isNeed: needs.includes(pos),
    }
  })

  const handleCut = async (playerId: number, name: string) => {
    if (!window.confirm(`Cut ${name}? They'll become a free agent and you'll free up their cap hit.`)) return
    setError(null)
    setCuttingId(playerId)
    try {
      await cutPlayer(leagueId, playerId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCuttingId(null)
    }
  }

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-500 mb-2">Your Roster by Position</h3>
      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-11 gap-2">
        {summary.map((s) => (
          <button
            key={s.pos}
            onClick={() => setExpanded(expanded === s.pos ? null : s.pos)}
            className={`rounded border px-2 py-1.5 text-center ${
              s.isNeed ? 'border-amber-700 bg-amber-900/20' : 'border-gray-700'
            } ${expanded === s.pos ? 'ring-1 ring-blue-400' : ''}`}
            title={`Top: ${s.group[0] ? `${s.group[0].firstName} ${s.group[0].lastName} (${s.group[0].ratings.overall})` : 'none'}`}
          >
            <div className="text-[10px] text-gray-500">{s.pos}</div>
            <div className="text-sm font-semibold text-green-400">{s.positionOverall || '-'}</div>
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-600 mt-1">
        Position overall reflects your starters, not a flat roster average. Amber = a position you currently need.
        Click a position to see/cut individual players and filter the list below to just that position.
      </p>
      {expanded && (
        <div className="mt-2 border rounded p-2 overflow-x-auto">
          <table className="text-sm border-collapse w-full">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="py-1 pr-4">Name</th>
                <th className="py-1 pr-4 text-right">Age</th>
                <th className="py-1 pr-4 text-right">OVR</th>
                <th className="py-1 pr-4 text-right">POT</th>
                <th className="py-1 pr-4 text-right">Salary</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {(byPosition.get(expanded) ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="py-1 text-gray-500">
                    No players at this position.
                  </td>
                </tr>
              )}
              {(byPosition.get(expanded) ?? [])
                .slice()
                .sort((a, b) => b.ratings.overall - a.ratings.overall)
                .map((p) => (
                  <tr key={p.id} className="border-b">
                    <td className="py-1 pr-4 whitespace-nowrap">
                      {p.firstName} {p.lastName}
                    </td>
                    <td className="py-1 pr-4 text-right">{p.age}</td>
                    <td className={`py-1 pr-4 text-right ${overallColor(p.ratings.overall)} font-semibold`}>{p.ratings.overall}</td>
                    <td className="py-1 pr-4 text-right text-yellow-400 font-semibold">{p.ratings.potential}</td>
                    <td className="py-1 pr-4 text-right whitespace-nowrap">
                      {p.contract ? formatMoney(p.contract.salary) : '-'}
                    </td>
                    <td className="py-1 text-right">
                      <button
                        onClick={() => handleCut(p.id, `${p.firstName} ${p.lastName}`)}
                        disabled={cuttingId === p.id}
                        className="px-2 py-0.5 border border-red-800 text-red-400 rounded text-[10px] disabled:opacity-30"
                        title="Cut this player and make them a free agent"
                      >
                        Cut
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * Generic sort by a value-extractor keyed off SortState.key; falls back to
 * leaving order unchanged for an unknown key. When two rows tie on the
 * primary key (most commonly Position, where every player at a position
 * ties), `tiebreak` breaks the tie by descending value (e.g. overall) so
 * ties don't fall back to whatever order the data happened to load in.
 */
function sortRows<T>(
  rows: T[],
  sort: SortState,
  valueFor: (row: T, key: string) => number | string,
  tiebreak?: (row: T) => number,
): T[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = valueFor(a, sort.key)
    const vb = valueFor(b, sort.key)
    const cmp =
      typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) * dir : (va - vb) * dir
    if (cmp !== 0) return cmp
    return tiebreak ? tiebreak(b) - tiebreak(a) : 0
  })
}

function formatMoney(n: number) {
  return `$${(n / 1_000_000).toFixed(1)}M`
}

/** Tiers a rating (overall/potential) into a consistent color so strong vs. weak players are readable at a glance across every table. */
function overallColor(n: number) {
  if (n >= 90) return 'text-fuchsia-400'
  if (n >= 80) return 'text-emerald-400'
  if (n >= 70) return 'text-cyan-400'
  if (n >= 60) return 'text-gray-300'
  return 'text-orange-400'
}

/** Short column-header abbreviation for a position attribute label, e.g. "Route Running" -> "RR", "Speed" -> "SPD". */
function abbrevLabel(label: string) {
  const words = label.split(' ')
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words.map((w) => w[0]).join('').toUpperCase()
}

interface SeasonStatTotals {
  passYards: number
  passTDs: number
  passAttempts: number
  passCompletions: number
  interceptions: number
  rushYards: number
  rushAttempts: number
  rushTDs: number
  recYards: number
  recTDs: number
  receptions: number
  tackles: number
  sacks: number
  tacklesForLoss: number
  passBreakups: number
  defInterceptions: number
  yardsAllowed: number
  passerRatingAllowedSum: number
  passerRatingAllowedGames: number
  pancakes: number
  sacksAllowed: number
  tflsAllowed: number
  fieldGoalsMade: number
  fieldGoalsAttempted: number
  longestFieldGoal: number
  extraPointsMade: number
  extraPointsAttempted: number
  puntCount: number
  puntYards: number
}

function emptySeasonTotals(): SeasonStatTotals {
  return {
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
    passerRatingAllowedSum: 0,
    passerRatingAllowedGames: 0,
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

function seasonStatLine(pos: Position, t?: SeasonStatTotals) {
  if (!t) return '-'
  if (pos === 'QB' && (t.passYards > 0 || t.passTDs > 0 || t.passAttempts > 0)) {
    const rating = passerRating(t.passAttempts, t.passCompletions, t.passYards, t.passTDs, t.interceptions)
    return `${t.passCompletions}/${t.passAttempts}, ${t.passYards} yds, ${t.passTDs} TD, ${t.interceptions} INT, ${rating.toFixed(1)} rating${t.rushYards > 0 ? ` · ${t.rushYards} rush yds` : ''}`
  }
  if (pos === 'RB' && (t.rushYards > 0 || t.rushTDs > 0 || t.recYards > 0)) {
    const avg = t.rushAttempts > 0 ? (t.rushYards / t.rushAttempts).toFixed(1) : '0.0'
    return `${t.rushAttempts} car, ${t.rushYards} yds (${avg} avg), ${t.rushTDs} TD${t.recYards > 0 ? ` · ${t.recYards} rec yds` : ''}`
  }
  if ((pos === 'WR' || pos === 'TE') && (t.recYards > 0 || t.recTDs > 0)) {
    return `${t.receptions} rec, ${t.recYards} yds, ${t.recTDs} TD`
  }
  if (pos === 'OL' && (t.pancakes > 0 || t.sacksAllowed > 0 || t.tflsAllowed > 0)) {
    return `${t.pancakes} pancakes, ${t.sacksAllowed} sacks allowed, ${t.tflsAllowed} TFLs allowed`
  }
  if ((pos === 'DL' || pos === 'LB') && (t.tackles > 0 || t.sacks > 0)) {
    return `${t.tackles} tkl, ${t.sacks} sacks, ${t.tacklesForLoss} TFL, ${t.passBreakups + t.defInterceptions} PBU/INT`
  }
  if ((pos === 'CB' || pos === 'S') && (t.tackles > 0 || t.yardsAllowed > 0)) {
    const rating = t.passerRatingAllowedGames > 0 ? Math.round(t.passerRatingAllowedSum / t.passerRatingAllowedGames) : 0
    return `${rating} rating allowed, ${t.passBreakups} PBU, ${t.defInterceptions} INT, ${t.yardsAllowed} yds allowed`
  }
  if (pos === 'K' && t.fieldGoalsAttempted > 0) {
    const fgPct = Math.round((t.fieldGoalsMade / t.fieldGoalsAttempted) * 100)
    const xpPct = t.extraPointsAttempted > 0 ? Math.round((t.extraPointsMade / t.extraPointsAttempted) * 100) : 0
    return `Long ${t.longestFieldGoal}, ${t.fieldGoalsMade}/${t.fieldGoalsAttempted} FG (${fgPct}%), ${t.extraPointsMade}/${t.extraPointsAttempted} XP (${xpPct}%)`
  }
  if (pos === 'P' && t.puntCount > 0) {
    const avgYards = Math.round(t.puntYards / t.puntCount)
    const avgFieldPosition = Math.max(1, 100 - avgYards)
    return `${avgYards} yds/punt avg, opponent starts ~${avgFieldPosition} yd line`
  }
  return '-'
}

/** Reuses seasonStatLine (built for a whole season's aggregated totals) for a single game's row, since the fields line up 1:1. */
function gameStatLine(pos: Position, s: PlayerGameStats) {
  return seasonStatLine(pos, {
    ...s,
    passerRatingAllowedSum: s.passerRatingAllowed,
    passerRatingAllowedGames: s.passerRatingAllowed > 0 ? 1 : 0,
  })
}

/** One team's full box score for a single game - every player with a recorded stat line, graded against position peers league-wide for that same week. */
function BoxScoreTable({
  title,
  stats,
  playerById,
  grades,
}: {
  title: string
  stats: PlayerGameStats[]
  playerById: Map<number, Player>
  grades: Map<number, SeasonGrade>
}) {
  const sorted = [...stats].sort((a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position))
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-400 mb-1">{title}</h4>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-gray-400 border-b">
            <th className="py-1 pr-2">Name</th>
            <th className="py-1 pr-2">Pos</th>
            <th className="py-1 pr-2 text-right">Grade</th>
            <th className="py-1 pl-2 text-left">Stat Line</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const player = playerById.get(s.playerId)
            const grade = grades.get(s.playerId)
            return (
              <tr key={s.playerId} className="border-b">
                <td className="py-1 pr-2 whitespace-nowrap">
                  {player ? `${player.firstName} ${player.lastName}` : `Player ${s.playerId}`}
                </td>
                <td className="py-1 pr-2">{s.position}</td>
                <td className={`py-1 pr-2 text-right font-semibold ${grade ? GRADE_COLORS[grade] : 'text-gray-600'}`}>
                  {grade ?? '-'}
                </td>
                <td className="py-1 pl-2 text-left text-gray-500 whitespace-nowrap">{gameStatLine(s.position, s)}</td>
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={4} className="py-1 text-gray-500">
                No recorded stats.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function RosterView({
  teamId,
  leagueId,
  season,
  editable,
}: {
  teamId: number
  leagueId: number
  season: number
  editable: boolean
}) {
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const roster = useLiveQuery(() => db.players.where('teamId').equals(teamId).toArray(), [teamId])
  const stats = useLiveQuery(
    () => db.playerGameStats.where('[leagueId+season]').equals([leagueId, season]).toArray(),
    [leagueId, season],
  )
  const [moving, setMoving] = useState<number | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [cuttingId, setCuttingId] = useState<number | null>(null)
  const [cutError, setCutError] = useState<string | null>(null)

  if (!team || !roster || !stats) return <p className="text-sm text-gray-500">Loading roster...</p>

  const statTotals = new Map<number, SeasonStatTotals>()
  for (const s of stats) {
    const t = statTotals.get(s.playerId) ?? emptySeasonTotals()
    t.passYards += s.passYards
    t.passTDs += s.passTDs
    t.passAttempts += s.passAttempts
    t.passCompletions += s.passCompletions
    t.interceptions += s.interceptions
    t.rushYards += s.rushYards
    t.rushAttempts += s.rushAttempts
    t.rushTDs += s.rushTDs
    t.recYards += s.recYards
    t.recTDs += s.recTDs
    t.receptions += s.receptions
    t.tackles += s.tackles
    t.sacks += s.sacks
    t.tacklesForLoss += s.tacklesForLoss
    t.passBreakups += s.passBreakups
    t.defInterceptions += s.defInterceptions
    t.yardsAllowed += s.yardsAllowed
    if (s.passerRatingAllowed > 0) {
      t.passerRatingAllowedSum += s.passerRatingAllowed
      t.passerRatingAllowedGames += 1
    }
    t.pancakes += s.pancakes
    t.sacksAllowed += s.sacksAllowed
    t.tflsAllowed += s.tflsAllowed
    t.fieldGoalsMade += s.fieldGoalsMade
    t.fieldGoalsAttempted += s.fieldGoalsAttempted
    t.longestFieldGoal = Math.max(t.longestFieldGoal, s.longestFieldGoal)
    t.extraPointsMade += s.extraPointsMade
    t.extraPointsAttempted += s.extraPointsAttempted
    t.puntCount += s.puntCount
    t.puntYards += s.puntYards
    statTotals.set(s.playerId, t)
  }

  const byPosition = new Map<Position, Player[]>()
  for (const p of roster) {
    const list = byPosition.get(p.position) ?? []
    list.push(p)
    byPosition.set(p.position, list)
  }
  for (const list of byPosition.values()) {
    list.sort((a, b) => a.depthOrder - b.depthOrder)
  }

  const teamOverall = Math.round(computeTeamOverall(roster))

  const handleMove = async (playerId: number, direction: 'up' | 'down') => {
    setMoving(playerId)
    try {
      await moveDepthChart(teamId, playerId, direction)
    } finally {
      setMoving(null)
    }
  }

  const handleOptimize = async () => {
    setOptimizing(true)
    try {
      await optimizeDepthChart(teamId)
    } finally {
      setOptimizing(false)
    }
  }

  const handleCut = async (playerId: number, name: string) => {
    if (!window.confirm(`Cut ${name}? They'll become a free agent and you'll free up their cap hit.`)) return
    setCutError(null)
    setCuttingId(playerId)
    try {
      await cutPlayer(leagueId, playerId)
    } catch (err) {
      setCutError(err instanceof Error ? err.message : String(err))
    } finally {
      setCuttingId(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4">
        <p className="text-sm text-gray-500">
          {roster.length} players &middot; Team overall {teamOverall} &middot; Cap space {formatMoney(computeCapSpace(roster))}
          {roster.some((p) => p.injury) && (
            <> &middot; {roster.filter((p) => p.injury).length} injured</>
          )}
          {editable && (
            <> &middot; Use the arrows to move a player up into the starting group (green) or down to the bench (gray) - starters get the bulk of the playing time, bench players see the field far less. ▲/▼ show recent form.</>
          )}
        </p>
        {editable && (
          <button
            onClick={handleOptimize}
            disabled={optimizing}
            className="px-3 py-1.5 border rounded-md text-xs whitespace-nowrap disabled:opacity-50"
            title="Sets every position's depth chart to best overall first"
          >
            {optimizing ? 'Optimizing...' : 'Best Roster'}
          </button>
        )}
      </div>

      {cutError && <p className="text-sm text-red-400 mb-3">{cutError}</p>}

      {POSITION_ORDER.map((pos) => {
        const players = byPosition.get(pos)
        if (!players || players.length === 0) return null
        const positionOverall = Math.round(computePositionOverall(players))
        const attrLabels = POSITION_ATTRIBUTES[pos]
        const starterCount = Math.min(STARTER_COUNTS[pos] ?? 1, players.length)
        return (
          <div key={pos} className="mb-6">
            <div className="flex items-baseline gap-2 mb-2">
              <h2 className="text-sm font-semibold text-gray-500">
                {pos} <span className="text-gray-600 font-normal">· {positionOverall} OVR</span>
              </h2>
              <p className="text-xs text-gray-600">
                {abbrevLabel(attrLabels[0])} = {attrLabels[0]} · {abbrevLabel(attrLabels[1])} = {attrLabels[1]} ·{' '}
                {abbrevLabel(attrLabels[2])} = {attrLabels[2]}
              </p>
            </div>
            <table className="text-sm border-collapse">
              <thead>
                <tr className="text-left text-gray-400 border-b">
                  {editable && <th className="py-1 pr-2 w-10"></th>}
                  <th className="py-1 pr-2 w-16">Status</th>
                  <th className="py-1 pr-6 min-w-[11rem]">Name</th>
                  <th className="py-1 px-2 text-right w-12">Age</th>
                  <th className="py-1 px-2 text-right w-12" title="Seasons played in the league - Rookie means their first year">Exp</th>
                  <th className="py-1 px-2 text-right w-12">OVR</th>
                  <th className="py-1 px-2 text-right w-12">POT</th>
                  <th className="py-1 px-2 text-right w-12" title={attrLabels[0]}>{abbrevLabel(attrLabels[0])}</th>
                  <th className="py-1 px-2 text-right w-12" title={attrLabels[1]}>{abbrevLabel(attrLabels[1])}</th>
                  <th className="py-1 px-2 text-right w-12" title={attrLabels[2]}>{abbrevLabel(attrLabels[2])}</th>
                  <th className="py-1 pl-4 pr-2 text-right w-20">Salary</th>
                  <th className="py-1 px-2 text-right w-12" title="Years left on current contract">Yrs Left</th>
                  <th className="py-1 pl-6 text-left">Season</th>
                  {editable && <th className="py-1 pl-4 w-16"></th>}
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => {
                  const isStarter = i < starterCount
                  return (
                    <tr
                      key={p.id}
                      className={`border-b ${i === starterCount ? 'border-t-2 border-t-gray-600' : ''}`}
                    >
                      {editable && (
                        <td className="py-1 pr-2">
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleMove(p.id, 'up')}
                              disabled={moving === p.id || i === 0}
                              className="px-1 border rounded text-[10px] disabled:opacity-30"
                              title="Move up depth chart"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => handleMove(p.id, 'down')}
                              disabled={moving === p.id || i === players.length - 1}
                              className="px-1 border rounded text-[10px] disabled:opacity-30"
                              title="Move down depth chart"
                            >
                              ↓
                            </button>
                          </div>
                        </td>
                      )}
                      <td className="py-1 pr-2">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap ${
                            isStarter ? 'bg-green-900 text-green-300' : 'bg-slate-700 text-slate-300'
                          }`}
                        >
                          {isStarter ? 'STARTER' : 'BENCH'}
                        </span>
                      </td>
                      <td className="py-1 pr-6 whitespace-nowrap">
                        {p.firstName} {p.lastName}
                        {p.injury && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-900 text-red-200">
                            {p.injury.description} · {p.injury.weeksRemaining}wk
                          </span>
                        )}
                        {p.onTradeBlock && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-200">
                            on block
                          </span>
                        )}
                      </td>
                      <td className="py-1 px-2 text-right">{p.age}</td>
                      <td className="py-1 px-2 text-right text-gray-400">
                        {!p.experience ? 'R' : p.experience}
                      </td>
                      <td className="py-1 px-2 text-right text-green-400 font-semibold">
                        {p.ratings.overall}
                        {p.trend === 'up' && <span className="ml-1 text-green-400" title="Playing well lately">▲</span>}
                        {p.trend === 'down' && <span className="ml-1 text-red-400" title="Playing poorly lately">▼</span>}
                      </td>
                      <td className="py-1 px-2 text-right text-yellow-400 font-semibold">{p.ratings.potential}</td>
                      <td className="py-1 px-2 text-right" title={attrLabels[0]}>{p.ratings.attr1}</td>
                      <td className="py-1 px-2 text-right" title={attrLabels[1]}>{p.ratings.attr2}</td>
                      <td className="py-1 px-2 text-right" title={attrLabels[2]}>{p.ratings.attr3}</td>
                      <td className="py-1 pl-4 pr-2 text-right whitespace-nowrap">
                        {p.contract ? formatMoney(p.contract.salary) : '-'}
                      </td>
                      <td className="py-1 px-2 text-right">{p.contract?.yearsLeft ?? '-'}</td>
                      <td className="py-1 pl-6 text-left text-gray-500 whitespace-nowrap">
                        {seasonStatLine(p.position, statTotals.get(p.id))}
                      </td>
                      {editable && (
                        <td className="py-1 pl-4 text-right whitespace-nowrap">
                          <button
                            onClick={() => toggleTradeBlock(p.id)}
                            className={`px-2 py-0.5 border rounded text-[10px] mr-1 ${
                              p.onTradeBlock ? 'border-blue-600 text-blue-300' : 'text-gray-500'
                            }`}
                            title="Flag this player as available in trade talks - AI teams may send offers for blocked players"
                          >
                            {p.onTradeBlock ? 'Blocked' : 'Block'}
                          </button>
                          <button
                            onClick={() => handleCut(p.id, `${p.firstName} ${p.lastName}`)}
                            disabled={cuttingId === p.id}
                            className="px-2 py-0.5 border border-red-800 text-red-400 rounded text-[10px] disabled:opacity-30"
                            title="Cut this player and make them a free agent"
                          >
                            Cut
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

const OUTCOME_TAG_COLORS: Record<'good' | 'bad', string> = {
  good: 'text-green-400',
  bad: 'text-red-400',
}

/**
 * Post-game breakdown for the user's own team: pick any game they played
 * this season, see who actually played well or poorly (by box score, not
 * just gut feel), and a plain-English read on what decided the result - so
 * a loss points to an actual roster weakness instead of just a final score.
 */
function GameReportView({
  leagueId,
  userTeamId,
  season,
  teamName,
}: {
  leagueId: number
  userTeamId: number
  season: number
  teamName: (id: number) => string
}) {
  const games = useLiveQuery(
    () =>
      db.games
        .where('leagueId')
        .equals(leagueId)
        .and((g) => g.season === season && (g.homeTeamId === userTeamId || g.awayTeamId === userTeamId))
        .toArray(),
    [leagueId, season, userTeamId],
  )
  const roster = useLiveQuery(() => db.players.where('teamId').equals(userTeamId).toArray(), [userTeamId])
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null)

  const sortedGames = games
    ? [...games].sort((a, b) => {
        const rank = (g: GameResult) => (g.round ? 1000 + ROUND_ORDER.indexOf(g.round) : g.week)
        return rank(b) - rank(a)
      })
    : []
  const selectedGame = sortedGames.find((g) => g.id === selectedGameId) ?? sortedGames[0] ?? null

  // playerGameStats only indexes [leagueId+season] and playerId (see db's
  // schema comment) - gameId/teamId are filtered in memory from that
  // season's rows, same as every other stats query in this app. Querying
  // .where('gameId') directly throws (not an indexed keyPath), which is
  // what was breaking this whole screen.
  const seasonStats = useLiveQuery(
    (): Promise<PlayerGameStats[]> =>
      db.playerGameStats.where('[leagueId+season]').equals([leagueId, season]).toArray(),
    [leagueId, season],
  )

  // Names for the box score aren't limited to the user's own roster - the
  // opponent's players need names too, and any of them (either side) could
  // since have been traded/cut, so look them up by id directly rather than
  // assuming they're still on the team they played for.
  const boxScorePlayers = useLiveQuery(
    (): Promise<Player[]> => {
      if (!selectedGame || !seasonStats) return Promise.resolve([])
      const ids = [...new Set(seasonStats.filter((s) => s.gameId === selectedGame.id).map((s) => s.playerId))]
      return db.players.bulkGet(ids).then((ps) => ps.filter((p): p is Player => p != null))
    },
    [selectedGame?.id, seasonStats],
  )

  if (!games || !roster || !seasonStats || !boxScorePlayers) {
    return <p className="text-sm text-gray-500">Loading game report...</p>
  }
  if (sortedGames.length === 0 || !selectedGame) {
    return <p className="text-sm text-gray-500">No games played yet this season.</p>
  }

  const statsForGame = seasonStats.filter((s) => s.gameId === selectedGame.id)
  const boxScorePlayerById = new Map(boxScorePlayers.map((p) => [p.id, p]))
  // Grades every player against their position peers league-wide *for this
  // one week* (not the whole season) - reuses gradeSeasonPerformance as-is,
  // since it just aggregates and grades whatever rows it's handed; handing
  // it a single week's rows makes it a single-game grade instead.
  const weekGrades = gradeSeasonPerformance(seasonStats.filter((s) => s.week === selectedGame.week))

  const isHome = selectedGame.homeTeamId === userTeamId
  const myScore = isHome ? selectedGame.homeScore : selectedGame.awayScore
  const oppScore = isHome ? selectedGame.awayScore : selectedGame.homeScore
  const oppTeamId = isHome ? selectedGame.awayTeamId : selectedGame.homeTeamId
  const won = myScore > oppScore
  const tied = myScore === oppScore

  const myStatLines = statsForGame.filter((s) => s.teamId === userTeamId)
  const rosterById = new Map(roster.map((p) => [p.id, p]))

  const graded = myStatLines
    .map((s) => {
      const tag = classifyGamePerformance(s.position, s)
      const player = rosterById.get(s.playerId)
      if (!tag || !player) return null
      return { player, tag, blurb: performanceBlurb(s.position, s, tag) }
    })
    .filter((x): x is { player: Player; tag: 'good' | 'bad'; blurb: string } => x !== null)

  const goodPerformers = graded.filter((g) => g.tag === 'good')
  const badPerformers = graded.filter((g) => g.tag === 'bad')
  const reasons = won || tied ? [] : buildGameReasons(myStatLines, won, myScore, oppScore)
  const winReasons = won ? buildGameReasons(myStatLines, won, myScore, oppScore) : []

  // Season-wide trend, not just this one game - a single bad game is noise,
  // but a position that keeps grading out poorly across multiple games is
  // an actual roster weakness worth addressing via free agency or a trade.
  const myTrendStats = seasonStats.filter((s) => s.teamId === userTeamId)
  const positionTrend = new Map<Position, { good: number; bad: number }>()
  for (const s of myTrendStats) {
    const tag = classifyGamePerformance(s.position, s)
    if (!tag) continue
    const entry = positionTrend.get(s.position) ?? { good: 0, bad: 0 }
    if (tag === 'good') entry.good++
    else entry.bad++
    positionTrend.set(s.position, entry)
  }
  const capSpace = computeCapSpace(roster)
  const weakPositions = POSITION_ORDER.map((pos) => {
    const trend = positionTrend.get(pos) ?? { good: 0, bad: 0 }
    const positionPlayers = roster.filter((p) => p.position === pos)
    const overall = positionPlayers.length > 0 ? Math.round(computePositionOverall(positionPlayers)) : 0
    return { pos, ...trend, net: trend.good - trend.bad, overall }
  })
    .filter((p) => p.bad > 0 && p.net < 0)
    .sort((a, b) => a.net - b.net)

  const turnoversCommitted = myStatLines
    .filter((s) => s.interceptions > 0)
    .map((s) => ({ player: rosterById.get(s.playerId), count: s.interceptions }))
    .filter((x): x is { player: Player; count: number } => x.player != null)
  const turnoversForced = myStatLines
    .filter((s) => s.defInterceptions > 0)
    .map((s) => ({ player: rosterById.get(s.playerId), count: s.defInterceptions }))
    .filter((x): x is { player: Player; count: number } => x.player != null)

  const roundLabel = selectedGame.round
    ? selectedGame.round[0].toUpperCase() + selectedGame.round.slice(1)
    : `Week ${selectedGame.week}`

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <select
          className="border rounded text-sm px-2 py-1 bg-transparent"
          value={selectedGame.id}
          onChange={(e) => setSelectedGameId(Number(e.target.value))}
        >
          {sortedGames.map((g) => {
            const gIsHome = g.homeTeamId === userTeamId
            const gMy = gIsHome ? g.homeScore : g.awayScore
            const gOpp = gIsHome ? g.awayScore : g.homeScore
            const gOppId = gIsHome ? g.awayTeamId : g.homeTeamId
            const label = g.round ? g.round[0].toUpperCase() + g.round.slice(1) : `Week ${g.week}`
            const result = gMy > gOpp ? 'W' : gMy < gOpp ? 'L' : 'T'
            return (
              <option key={g.id} value={g.id} className="text-black">
                {label} - {result} {gMy}-{gOpp} vs {teamName(gOppId)}
              </option>
            )
          })}
        </select>
        <p className="text-sm text-gray-500">
          {roundLabel} &middot;{' '}
          <span className={won ? 'text-green-400 font-semibold' : tied ? 'text-gray-300' : 'text-red-400 font-semibold'}>
            {won ? 'WIN' : tied ? 'TIE' : 'LOSS'} {myScore}-{oppScore}
          </span>{' '}
          vs {teamName(oppTeamId)}
        </p>
      </div>

      <div className="mb-6 border rounded p-3">
        <h3 className="text-sm font-semibold text-gray-500 mb-2">
          {won ? 'What went right' : tied ? 'How it played out' : 'Why we lost'}
        </h3>
        <ul className="text-sm space-y-1 list-disc list-inside text-gray-300">
          {(won ? winReasons : reasons).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {tied && <li>Game ended tied - review the individual performances below for what to fix.</li>}
        </ul>
      </div>

      {(turnoversCommitted.length > 0 || turnoversForced.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-red-400 mb-2">Turned It Over</h3>
            {turnoversCommitted.length === 0 && <p className="text-xs text-gray-600">No turnovers given up.</p>}
            <ul className="text-sm space-y-1.5">
              {turnoversCommitted.map(({ player, count }) => (
                <li key={player.id} className="flex justify-between gap-2 border-b border-gray-800 pb-1">
                  <span>
                    {player.firstName} {player.lastName}{' '}
                    <span className="text-gray-500 text-xs">({player.position})</span>
                  </span>
                  <span className="text-xs whitespace-nowrap text-red-400">
                    {count} INT thrown
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-green-400 mb-2">Takeaways</h3>
            {turnoversForced.length === 0 && <p className="text-xs text-gray-600">No takeaways forced.</p>}
            <ul className="text-sm space-y-1.5">
              {turnoversForced.map(({ player, count }) => (
                <li key={player.id} className="flex justify-between gap-2 border-b border-gray-800 pb-1">
                  <span>
                    {player.firstName} {player.lastName}{' '}
                    <span className="text-gray-500 text-xs">({player.position})</span>
                  </span>
                  <span className="text-xs whitespace-nowrap text-green-400">{count} INT made</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-gray-500 mb-2">Box Score</h3>
        <p className="text-xs text-gray-600 mb-2">
          Every player who recorded a stat this game, graded against their position peers league-wide for this same
          week - not just the standout performances above.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <BoxScoreTable
            title={teamName(userTeamId)}
            stats={statsForGame.filter((s) => s.teamId === userTeamId)}
            playerById={boxScorePlayerById}
            grades={weekGrades}
          />
          <BoxScoreTable
            title={teamName(oppTeamId)}
            stats={statsForGame.filter((s) => s.teamId === oppTeamId)}
            playerById={boxScorePlayerById}
            grades={weekGrades}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold text-green-400 mb-2">Played Well</h3>
          {goodPerformers.length === 0 && <p className="text-xs text-gray-600">No standout performances this game.</p>}
          <ul className="text-sm space-y-1.5">
            {goodPerformers.map(({ player, blurb }) => (
              <li key={player.id} className="flex justify-between gap-2 border-b border-gray-800 pb-1">
                <span>
                  {player.firstName} {player.lastName}{' '}
                  <span className="text-gray-500 text-xs">({player.position})</span>
                </span>
                <span className={`text-xs whitespace-nowrap ${OUTCOME_TAG_COLORS.good}`}>{blurb}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-red-400 mb-2">Played Poorly</h3>
          {badPerformers.length === 0 && <p className="text-xs text-gray-600">No poor performances this game.</p>}
          <ul className="text-sm space-y-1.5">
            {badPerformers.map(({ player, blurb }) => (
              <li key={player.id} className="flex justify-between gap-2 border-b border-gray-800 pb-1">
                <span>
                  {player.firstName} {player.lastName}{' '}
                  <span className="text-gray-500 text-xs">({player.position})</span>
                </span>
                <span className={`text-xs whitespace-nowrap ${OUTCOME_TAG_COLORS.bad}`}>{blurb}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 border rounded p-3">
        <h3 className="text-sm font-semibold text-gray-500 mb-2">Season Trends - Where to Upgrade</h3>
        <p className="text-xs text-gray-600 mb-2">
          Positions with more bad games than good ones across the {sortedGames.length} game(s) played so far this season - a
          single rough game is noise, a repeated one is a real weakness. Cap space: {formatMoney(capSpace)}.
        </p>
        {weakPositions.length === 0 && (
          <p className="text-xs text-gray-600">No position has a losing performance trend yet.</p>
        )}
        <ul className="text-sm space-y-1.5">
          {weakPositions.map((w) => (
            <li key={w.pos} className="flex justify-between gap-2 border-b border-gray-800 pb-1">
              <span>
                <span className="font-semibold">{w.pos}</span>{' '}
                <span className="text-gray-500 text-xs">({w.overall} OVR)</span>
              </span>
              <span className="text-xs whitespace-nowrap text-red-400">
                {w.bad} bad vs {w.good} good game(s) - consider {capSpace > 0 ? 'free agency or a trade' : 'a trade'} to upgrade
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const PICK_YEARS_AHEAD = 5

function pickRefKey(r: TradePickRef) {
  return `${r.year}-${r.round}-${r.originalTeamId}`
}

/** "2027 R1" normally, or "2027 R1 (via BUF)" when it's someone else's pick a team acquired. */
function pickLabel(r: TradePickRef, teamId: number, teamAbbrev: (id: number) => string) {
  const base = `${r.year} R${r.round}`
  return r.originalTeamId === teamId ? base : `${base} (via ${teamAbbrev(r.originalTeamId)})`
}

function TradeView({
  leagueId,
  userTeamId,
  season,
  teamName,
}: {
  leagueId: number
  userTeamId: number
  season: number
  teamName: (id: number) => string
}) {
  const teams = useLiveQuery(() => db.teams.toArray(), [])
  const league = useLiveQuery(() => db.leagues.get(leagueId), [leagueId])
  const myRoster = useLiveQuery(
    () => db.players.where('teamId').equals(userTeamId).toArray(),
    [userTeamId],
  )
  const [otherTeamId, setOtherTeamId] = useState<number | null>(null)
  const [giveIds, setGiveIds] = useState<Set<number>>(new Set())
  const [getIds, setGetIds] = useState<Set<number>>(new Set())
  const [givePickKeys, setGivePickKeys] = useState<Set<string>>(new Set())
  const [getPickKeys, setGetPickKeys] = useState<Set<string>>(new Set())
  const [proposing, setProposing] = useState(false)
  const [result, setResult] = useState<{ accepted: boolean; reason: string } | null>(null)
  const [giveSort, setGiveSort] = useState<SortState>({ key: 'overall', dir: 'desc' })
  const [getSort, setGetSort] = useState<SortState>({ key: 'overall', dir: 'desc' })
  const [respondingOfferId, setRespondingOfferId] = useState<number | null>(null)
  const [makingSuggestionKey, setMakingSuggestionKey] = useState<string | null>(null)
  const [suggestionResult, setSuggestionResult] = useState<{ key: string; accepted: boolean; reason: string } | null>(null)

  const suggestedTrades = useLiveQuery(() => findSuggestedTrades(leagueId), [leagueId, myRoster])

  const otherRoster = useLiveQuery(
    (): Promise<Player[]> =>
      otherTeamId != null ? db.players.where('teamId').equals(otherTeamId).toArray() : Promise.resolve([]),
    [otherTeamId],
  )

  if (!teams || !myRoster || !league) return <p className="text-sm text-gray-500">Loading...</p>

  const abbrev = (id: number) => teams.find((t) => t.id === id)?.abbrev ?? `#${id}`
  const otherTeams = teams.filter((t) => t.id !== userTeamId)
  const allTeamIds = teams.map((t) => t.id)

  const toggle = (set: Set<number>, setFn: (s: Set<number>) => void, id: number) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFn(next)
  }
  const togglePick = (set: Set<string>, setFn: (s: Set<string>) => void, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setFn(next)
  }

  const myPicks = ownedPicks(league.tradedPicks, season, allTeamIds, userTeamId, PICK_YEARS_AHEAD)
  const otherPicks =
    otherTeamId != null ? ownedPicks(league.tradedPicks, season, allTeamIds, otherTeamId, PICK_YEARS_AHEAD) : []
  const myPickByKey = new Map(myPicks.map((r) => [pickRefKey(r), r]))
  const otherPickByKey = new Map(otherPicks.map((r) => [pickRefKey(r), r]))

  const giveSalary = myRoster.filter((p) => giveIds.has(p.id)).reduce((s, p) => s + (p.contract?.salary ?? 0), 0)
  const getSalary = (otherRoster ?? []).filter((p) => getIds.has(p.id)).reduce((s, p) => s + (p.contract?.salary ?? 0), 0)
  const myCapSpace = computeCapSpace(myRoster)
  const myCapSpaceAfter = myCapSpace + giveSalary - getSalary
  const otherCapSpace = otherRoster ? computeCapSpace(otherRoster) : 0
  const otherCapSpaceAfter = otherCapSpace + getSalary - giveSalary

  const handlePropose = async () => {
    if (otherTeamId == null) return
    setProposing(true)
    setResult(null)
    try {
      const outcome = await proposeTrade(
        leagueId,
        userTeamId,
        otherTeamId,
        [...giveIds],
        [...getIds],
        [...givePickKeys].map((k) => myPickByKey.get(k)).filter((r): r is TradePickRef => r != null),
        [...getPickKeys].map((k) => otherPickByKey.get(k)).filter((r): r is TradePickRef => r != null),
      )
      setResult(outcome)
      if (outcome.accepted) {
        setGiveIds(new Set())
        setGetIds(new Set())
        setGivePickKeys(new Set())
        setGetPickKeys(new Set())
      }
    } finally {
      setProposing(false)
    }
  }

  const handleToggleBlock = async (playerId: number) => {
    await toggleTradeBlock(playerId)
  }

  const handleRespondOffer = async (offerId: number, accept: boolean) => {
    setRespondingOfferId(offerId)
    try {
      if (accept) await acceptTradeOffer(leagueId, offerId)
      else await removeTradeOffer(leagueId, offerId)
    } finally {
      setRespondingOfferId(null)
    }
  }

  const handleMakeSuggestion = async (s: SuggestedTrade, key: string) => {
    setMakingSuggestionKey(key)
    setSuggestionResult(null)
    try {
      const outcome = await proposeTrade(leagueId, userTeamId, s.otherTeamId, s.giveIds, s.getIds)
      setSuggestionResult({ key, accepted: outcome.accepted, reason: outcome.reason })
    } finally {
      setMakingSuggestionKey(null)
    }
  }

  const renderRoster = (
    roster: Player[],
    selected: Set<number>,
    setFn: (s: Set<number>) => void,
    sort: SortState,
    setSort: (s: SortState) => void,
    showBlockToggle: boolean,
  ) => (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-gray-400 border-b">
          <th className="py-1"></th>
          <SortHeader label="Name" sortKey="name" sort={sort} setSort={setSort} />
          <SortHeader label="Pos" sortKey="pos" sort={sort} setSort={setSort} />
          <SortHeader label="OVR" sortKey="overall" sort={sort} setSort={setSort} className="text-right" />
          <SortHeader label="Salary" sortKey="salary" sort={sort} setSort={setSort} className="text-right" />
          {showBlockToggle && <th className="py-1 text-right">Block</th>}
        </tr>
      </thead>
      <tbody>
        {sortRows(
          roster,
          sort,
          (p, key) => {
            if (key === 'name') return `${p.firstName} ${p.lastName}`
            if (key === 'pos') return POSITION_ORDER.indexOf(p.position)
            if (key === 'salary') return p.contract?.salary ?? 0
            return p.ratings.overall
          },
          (p) => p.ratings.overall,
        ).map((p) => (
          <tr key={p.id} className="border-b">
            <td className="py-1">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(selected, setFn, p.id)}
              />
            </td>
            <td className="py-1">
              {p.firstName} {p.lastName}
              {p.onTradeBlock && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-200">on block</span>
              )}
            </td>
            <td className="py-1">{p.position}</td>
            <td className={`py-1 text-right ${overallColor(p.ratings.overall)} font-semibold`}>{p.ratings.overall}</td>
            <td className="py-1 text-right whitespace-nowrap">{p.contract ? formatMoney(p.contract.salary) : '-'}</td>
            {showBlockToggle && (
              <td className="py-1 text-right">
                <button
                  onClick={() => handleToggleBlock(p.id)}
                  className={`px-2 py-0.5 border rounded text-[10px] ${
                    p.onTradeBlock ? 'border-blue-600 text-blue-300' : 'text-gray-500'
                  }`}
                >
                  {p.onTradeBlock ? 'Remove' : 'Add'}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )

  const renderPicks = (
    picks: TradePickRef[],
    teamId: number,
    selected: Set<string>,
    setFn: (s: Set<string>) => void,
  ) => {
    if (picks.length === 0) {
      return <p className="text-xs text-gray-600 mt-2">No picks owned in the next {PICK_YEARS_AHEAD} years.</p>
    }
    const byYear = new Map<number, TradePickRef[]>()
    for (const r of picks) {
      const list = byYear.get(r.year) ?? []
      list.push(r)
      byYear.set(r.year, list)
    }
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        {[...byYear.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([year, refs]) => (
            <div key={year} className="flex flex-wrap gap-1 items-center text-xs">
              <span className="text-gray-500 w-10 shrink-0">{year}</span>
              {refs
                .sort((a, b) => a.round - b.round)
                .map((r) => {
                  const key = pickRefKey(r)
                  const checked = selected.has(key)
                  return (
                    <button
                      key={key}
                      onClick={() => togglePick(selected, setFn, key)}
                      title={pickLabel(r, teamId, abbrev)}
                      className={`px-1.5 py-0.5 rounded border ${
                        checked ? 'border-blue-500 bg-blue-900/50 text-blue-200' : 'border-gray-700 text-gray-400'
                      }`}
                    >
                      R{r.round}
                      {r.originalTeamId !== teamId && <span className="text-[9px]">*</span>}
                    </button>
                  )
                })}
            </div>
          ))}
        <p className="text-[10px] text-gray-600">* = acquired via a previous trade, not this team's own original pick.</p>
      </div>
    )
  }

  const pendingOffers = league.pendingTradeOffers ?? []

  return (
    <div>
      {suggestedTrades && suggestedTrades.length > 0 && (
        <div className="mb-6 border border-emerald-800 rounded p-3 bg-emerald-950/30">
          <h3 className="text-sm font-semibold text-emerald-300 mb-2">
            Suggested Trades for You ({suggestedTrades.length})
          </h3>
          <div className="flex flex-col gap-2">
            {suggestedTrades.map((s) => {
              const key = `${s.otherTeamId}-${s.giveIds[0]}-${s.getIds[0]}`
              const netSalary = s.get.salary - s.give.salary
              return (
                <div key={key} className="border-b border-emerald-900 pb-2 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3 text-xs mb-1.5">
                    <span>
                      <span className="text-emerald-300 font-medium">{teamName(s.otherTeamId)}</span>
                      <span className="text-gray-400"> &middot; {s.reason}</span>
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {suggestionResult?.key === key && (
                        <span className={suggestionResult.accepted ? 'text-emerald-400' : 'text-red-400'}>
                          {suggestionResult.accepted ? 'Done!' : suggestionResult.reason}
                        </span>
                      )}
                      <button
                        onClick={() => handleMakeSuggestion(s, key)}
                        disabled={makingSuggestionKey === key}
                        className="px-2 py-1 bg-emerald-600 text-white rounded text-[11px] disabled:opacity-50"
                      >
                        {makingSuggestionKey === key ? 'Trading...' : 'Make Trade'}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-[11px]">
                    <div className="bg-black/20 rounded px-2 py-1.5">
                      <div className="text-gray-500 mb-0.5">You send</div>
                      <div className="flex items-center justify-between">
                        <span>
                          {s.give.firstName} {s.give.lastName} <span className="text-gray-500">({s.give.position})</span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className={overallColor(s.give.overall)}>{s.give.overall} OVR</span>
                          <span className="text-yellow-400">{s.give.potential} POT</span>
                          <span className="text-gray-400 whitespace-nowrap">{formatMoney(s.give.salary)}</span>
                        </span>
                      </div>
                    </div>
                    <div className="bg-black/20 rounded px-2 py-1.5">
                      <div className="text-gray-500 mb-0.5">You get</div>
                      <div className="flex items-center justify-between">
                        <span>
                          {s.get.firstName} {s.get.lastName} <span className="text-gray-500">({s.get.position})</span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className={overallColor(s.get.overall)}>{s.get.overall} OVR</span>
                          <span className="text-yellow-400">{s.get.potential} POT</span>
                          <span className="text-gray-400 whitespace-nowrap">{formatMoney(s.get.salary)}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">
                    Net cap impact:{' '}
                    <span className={netSalary > 0 ? 'text-red-400' : netSalary < 0 ? 'text-emerald-400' : 'text-gray-400'}>
                      {netSalary === 0 ? 'even' : `${netSalary > 0 ? '+' : '-'}${formatMoney(Math.abs(netSalary))}/yr`}
                    </span>
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {pendingOffers.length > 0 && (
        <div className="mb-6 border border-blue-800 rounded p-3 bg-blue-950/30">
          <h3 className="text-sm font-semibold text-blue-300 mb-2">Incoming Trade Offers ({pendingOffers.length})</h3>
          <div className="flex flex-col gap-2">
            {pendingOffers.map((offer) => (
              <TradeOfferRow
                key={offer.id}
                offer={offer}
                teamName={teamName}
                season={season}
                responding={respondingOfferId === offer.id}
                onRespond={(accept) => handleRespondOffer(offer.id, accept)}
              />
            ))}
          </div>
        </div>
      )}

      <p className="text-sm text-gray-500 mb-2 text-left">
        Trade with &middot; Your cap space: {formatMoney(myCapSpace)}
      </p>
      <select
        className="border rounded-md px-3 py-2 text-sm mb-4"
        value={otherTeamId ?? ''}
        onChange={(e) => {
          setOtherTeamId(e.target.value ? Number(e.target.value) : null)
          setGiveIds(new Set())
          setGetIds(new Set())
          setGivePickKeys(new Set())
          setGetPickKeys(new Set())
          setResult(null)
        }}
      >
        <option value="">Select a team...</option>
        {otherTeams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.region} {t.name}
          </option>
        ))}
      </select>

      {otherTeamId != null && otherRoster && (
        <>
          <div className="grid grid-cols-2 gap-6 mb-4">
            <div>
              <h3 className="text-sm font-semibold mb-2">You give ({giveIds.size + givePickKeys.size})</h3>
              <p className="text-xs mb-2">
                Your cap space after:{' '}
                <span className={myCapSpaceAfter < 0 ? 'text-red-400 font-semibold' : 'text-green-400'}>
                  {formatMoney(myCapSpaceAfter)}
                </span>
              </p>
              {renderRoster(myRoster, giveIds, setGiveIds, giveSort, setGiveSort, true)}
              <h4 className="text-xs font-semibold text-gray-400 mt-3">Your draft picks</h4>
              {renderPicks(myPicks, userTeamId, givePickKeys, setGivePickKeys)}
            </div>
            <div>
              <h3 className="text-sm font-semibold mb-2">You get ({getIds.size + getPickKeys.size})</h3>
              <p className="text-xs mb-2">
                {teamName(otherTeamId)} cap space after:{' '}
                <span className={otherCapSpaceAfter < 0 ? 'text-red-400 font-semibold' : 'text-green-400'}>
                  {formatMoney(otherCapSpaceAfter)}
                </span>{' '}
                <span className="text-gray-600">(currently {formatMoney(otherCapSpace)})</span>
              </p>
              {renderRoster(otherRoster, getIds, setGetIds, getSort, setGetSort, false)}
              <h4 className="text-xs font-semibold text-gray-400 mt-3">Their draft picks</h4>
              {renderPicks(otherPicks, otherTeamId, getPickKeys, setGetPickKeys)}
            </div>
          </div>

          <button
            onClick={handlePropose}
            disabled={
              proposing ||
              (giveIds.size === 0 && getIds.size === 0 && givePickKeys.size === 0 && getPickKeys.size === 0)
            }
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm disabled:opacity-50"
          >
            {proposing ? 'Proposing...' : 'Propose Trade'}
          </button>

          {result && (
            <p className={`text-sm mt-3 ${result.accepted ? 'text-green-400' : 'text-red-400'}`}>
              {result.accepted ? 'Accepted: ' : 'Rejected: '}
              {result.reason}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** One row in the Incoming Trade Offers panel - what the AI team is sending vs. asking for, with an estimated pick value hint. */
function TradeOfferRow({
  offer,
  teamName,
  season,
  responding,
  onRespond,
}: {
  offer: PendingTradeOffer
  teamName: (id: number) => string
  season: number
  responding: boolean
  onRespond: (accept: boolean) => void
}) {
  const offerPlayers = useLiveQuery(
    (): Promise<Player[]> => db.players.bulkGet(offer.offerPlayerIds).then((ps) => ps.filter((p): p is Player => p != null)),
    [offer.id],
  )
  const requestPlayers = useLiveQuery(
    (): Promise<Player[]> => db.players.bulkGet(offer.requestPlayerIds).then((ps) => ps.filter((p): p is Player => p != null)),
    [offer.id],
  )

  if (!offerPlayers || !requestPlayers) return null

  const pickText = (refs: TradePickRef[]) =>
    refs.map((r) => `${r.year} R${r.round} pick (trade value ~${Math.round(pickValue(r.round, r.year - season))})`)

  return (
    <div className="border rounded p-2 flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm">
        <span className="font-semibold">{teamName(offer.fromTeamId)}</span> offers{' '}
        {[...offerPlayers.map((p) => `${p.firstName} ${p.lastName} (${p.position}, ${p.ratings.overall} OVR)`), ...pickText(offer.offerPicks)].join(
          ', ',
        )}{' '}
        for {[...requestPlayers.map((p) => `${p.firstName} ${p.lastName}`), ...pickText(offer.requestPicks)].join(', ')}
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={() => onRespond(true)}
          disabled={responding}
          className="px-3 py-1 bg-green-600 text-white rounded text-xs disabled:opacity-50"
        >
          Accept
        </button>
        <button
          onClick={() => onRespond(false)}
          disabled={responding}
          className="px-3 py-1 border rounded text-xs disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  )
}

interface StatLeaderRow {
  playerId: number
  value: number
  extra?: number
}

function HistoryView({
  leagueId,
  userTeamId,
  teamName,
}: {
  leagueId: number
  userTeamId: number | null
  teamName: (id: number) => string
}) {
  const history = useLiveQuery(() => getSeasonHistory(leagueId), [leagueId])

  if (!history) return <p className="text-sm text-gray-500">Loading history...</p>

  if (history.length === 0) {
    return <p className="text-sm text-gray-500">No seasons completed yet.</p>
  }

  return (
    <div>
      <h2 className="text-lg font-medium mb-2">League History</h2>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-gray-400 border-b">
            <th className="py-1">Season</th>
            <th className="py-1">Champion</th>
            <th className="py-1">Runner-up</th>
            <th className="py-1 text-right">Score</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr
              key={h.season}
              className={`border-b ${
                userRowClass(h.champTeamId, userTeamId) || userRowClass(h.runnerUpTeamId, userTeamId)
              }`}
            >
              <td className="py-1 pl-1">{h.season}</td>
              <td className="py-1">
                🏆 {teamName(h.champTeamId)}
                {h.champTeamId === userTeamId && <span className="text-xs text-blue-400"> (you)</span>}
              </td>
              <td className="py-1">
                {teamName(h.runnerUpTeamId)}
                {h.runnerUpTeamId === userTeamId && <span className="text-xs text-blue-400"> (you)</span>}
              </td>
              <td className="py-1 text-right">
                {h.champScore}-{h.runnerUpScore}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatsLeadersView({
  leagueId,
  season,
  userTeamId,
}: {
  leagueId: number
  season: number
  userTeamId: number | null
}) {
  const stats = useLiveQuery(
    () => db.playerGameStats.where('[leagueId+season]').equals([leagueId, season]).toArray(),
    [leagueId, season],
  )
  const players = useLiveQuery(() => db.players.toArray(), [])
  const teams = useLiveQuery(() => db.teams.toArray(), [])

  if (!stats || !players || !teams) return <p className="text-sm text-gray-500">Loading stats...</p>

  const playerById = new Map(players.map((p) => [p.id, p]))
  const teamById = new Map(teams.map((t) => [t.id, t]))

  interface StatTotals {
    passYards: number
    passTDs: number
    passAttempts: number
    passCompletions: number
    interceptions: number
    rushYards: number
    rushTDs: number
    recYards: number
    recTDs: number
    tackles: number
    sacks: number
    tacklesForLoss: number
  }
  const totals = new Map<number, StatTotals>()
  for (const s of stats) {
    const t = totals.get(s.playerId) ?? {
      passYards: 0,
      passTDs: 0,
      passAttempts: 0,
      passCompletions: 0,
      interceptions: 0,
      rushYards: 0,
      rushTDs: 0,
      recYards: 0,
      recTDs: 0,
      tackles: 0,
      sacks: 0,
      tacklesForLoss: 0,
    }
    t.passYards += s.passYards
    t.passTDs += s.passTDs
    t.passAttempts += s.passAttempts
    t.passCompletions += s.passCompletions
    t.interceptions += s.interceptions
    t.rushYards += s.rushYards
    t.rushTDs += s.rushTDs
    t.recYards += s.recYards
    t.recTDs += s.recTDs
    t.tackles += s.tackles
    t.sacks += s.sacks
    t.tacklesForLoss += s.tacklesForLoss
    totals.set(s.playerId, t)
  }

  const topBy = (statKey: keyof StatTotals, extraKey?: keyof StatTotals): StatLeaderRow[] =>
    [...totals.entries()]
      .map(([playerId, t]) => ({ playerId, value: t[statKey], extra: extraKey ? t[extraKey] : undefined }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)

  const categories: { title: string; unit: string; rows: StatLeaderRow[] }[] = [
    { title: 'Passing Yards', unit: 'yds', rows: topBy('passYards', 'passTDs') },
    { title: 'Passing TDs', unit: 'TD', rows: topBy('passTDs') },
    { title: 'Interceptions', unit: 'INT', rows: topBy('interceptions') },
    { title: 'Rushing Yards', unit: 'yds', rows: topBy('rushYards', 'rushTDs') },
    { title: 'Rushing TDs', unit: 'TD', rows: topBy('rushTDs') },
    { title: 'Receiving Yards', unit: 'yds', rows: topBy('recYards', 'recTDs') },
    { title: 'Receiving TDs', unit: 'TD', rows: topBy('recTDs') },
    { title: 'Tackles', unit: 'tkl', rows: topBy('tackles') },
    { title: 'Sacks', unit: 'sacks', rows: topBy('sacks') },
    { title: 'Tackles for Loss', unit: 'TFL', rows: topBy('tacklesForLoss') },
  ]

  const nameFor = (playerId: number) => {
    const p = playerById.get(playerId)
    if (!p) return `Player ${playerId}`
    const team = p.teamId != null ? teamById.get(p.teamId) : undefined
    return `${p.firstName} ${p.lastName}${team ? ` (${team.abbrev})` : ''}`
  }

  const isUserPlayer = (playerId: number) => {
    const p = playerById.get(playerId)
    return p != null && p.teamId != null && p.teamId === userTeamId
  }

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6">
      {categories.map((cat) => (
        <div key={cat.title}>
          <h3 className="text-sm font-semibold mb-2">{cat.title}</h3>
          {cat.rows.length === 0 ? (
            <p className="text-xs text-gray-500">No data yet.</p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <tbody>
                {cat.rows.map((r, i) => (
                  <tr
                    key={r.playerId}
                    className={`border-b ${isUserPlayer(r.playerId) ? 'bg-blue-900/50 border-l-2 border-l-blue-400 text-blue-100 font-medium' : ''}`}
                  >
                    <td className="py-1 text-gray-400 w-5 pl-1">{i + 1}</td>
                    <td className="py-1">{nameFor(r.playerId)}</td>
                    <td className="py-1 text-right">
                      {r.value.toLocaleString()} {cat.unit}
                      {r.extra != null && r.extra > 0 ? ` · ${r.extra} TD` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  )
}

function ResignView({
  leagueId,
  userTeamId,
  season,
  onOpenFreeAgency,
}: {
  leagueId: number
  userTeamId: number
  season: number
  onOpenFreeAgency: () => void
}) {
  const roster = useLiveQuery(
    () => db.players.where('teamId').equals(userTeamId).toArray(),
    [userTeamId],
  )
  // Unfiltered by team on purpose - grading needs the whole league's stats
  // so a player's season is judged against every peer at their position,
  // not just their own 52 teammates.
  const leagueStats = useLiveQuery(
    () => db.playerGameStats.where('[leagueId+season]').equals([leagueId, season - 1]).toArray(),
    [leagueId, season],
  )
  const [cuttingId, setCuttingId] = useState<number | null>(null)
  const [resigningId, setResigningId] = useState<number | null>(null)
  const [yearsByPlayer, setYearsByPlayer] = useState<Map<number, number>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'overall', dir: 'desc' })

  if (!roster || !leagueStats) return <p className="text-sm text-gray-500">Loading roster...</p>

  const statTotals = new Map<number, number>()
  for (const s of leagueStats) {
    const total = s.passYards + s.rushYards + s.recYards + (s.passTDs + s.rushTDs + s.recTDs) * 20
    statTotals.set(s.playerId, (statTotals.get(s.playerId) ?? 0) + total)
  }
  const grades = gradeSeasonPerformance(leagueStats)

  const capSpace = computeCapSpace(roster)
  const yearsFor = (playerId: number) => yearsByPlayer.get(playerId) ?? 2

  const handleCut = async (playerId: number) => {
    setError(null)
    setCuttingId(playerId)
    try {
      await cutPlayer(leagueId, playerId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCuttingId(null)
    }
  }

  const handleResign = async (playerId: number) => {
    setError(null)
    setResigningId(playerId)
    try {
      await resignPlayer(leagueId, playerId, yearsFor(playerId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResigningId(null)
    }
  }

  const handleOpen = async () => {
    setOpening(true)
    try {
      await openFreeAgency(leagueId)
      onOpenFreeAgency()
    } finally {
      setOpening(false)
    }
  }

  const sorted = sortRows(
    roster,
    sort,
    (p, key) => {
      if (key === 'name') return `${p.firstName} ${p.lastName}`
      if (key === 'pos') return POSITION_ORDER.indexOf(p.position)
      if (key === 'age') return p.age
      if (key === 'pot') return p.ratings.potential
      if (key === 'grade') return grades.get(p.id) ?? ''
      if (key === 'salary') return p.contract?.salary ?? -1
      if (key === 'yrs') return p.contract?.yearsLeft ?? -1
      if (key === 'asking') return marketSalary(p.position, p.ratings.overall, p.age)
      return p.ratings.overall
    },
    (p) => p.ratings.overall,
  )
  const needsDecisionCount = roster.filter((p) => p.contract === null).length

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          Re-sign expiring contracts, extend anyone you want to lock up longer, or cut players you don't
          want - all before free agency opens. Cap space {formatMoney(capSpace)}
          {needsDecisionCount > 0 && (
            <>
              {' '}
              &middot; <span className="text-amber-400">{needsDecisionCount} contract(s) need a decision</span>
            </>
          )}
        </p>
        <button
          onClick={handleOpen}
          disabled={opening}
          className="px-4 py-2 bg-green-600 text-white rounded-md text-sm disabled:opacity-50"
        >
          {opening ? 'Opening...' : 'Open Free Agency'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <table className="text-sm border-collapse">
        <thead>
          <tr className="text-left text-gray-400 border-b">
            <SortHeader label="Name" sortKey="name" sort={sort} setSort={setSort} className="pr-6 min-w-[11rem]" />
            <SortHeader label="Pos" sortKey="pos" sort={sort} setSort={setSort} className="px-2" />
            <SortHeader label="Age" sortKey="age" sort={sort} setSort={setSort} className="px-2 text-right" />
            <SortHeader label="OVR" sortKey="overall" sort={sort} setSort={setSort} className="px-2 text-right" />
            <SortHeader label="POT" sortKey="pot" sort={sort} setSort={setSort} className="px-2 text-right" />
            <SortHeader label="Grade" sortKey="grade" sort={sort} setSort={setSort} className="px-2 text-right" />
            <th className="py-1 pl-6 text-left">Last Season</th>
            <SortHeader label="Salary" sortKey="salary" sort={sort} setSort={setSort} className="pl-4 pr-2 text-right" />
            <SortHeader label="Yrs Left" sortKey="yrs" sort={sort} setSort={setSort} className="px-2 text-right" />
            <SortHeader
              label="Resign/Ext Price"
              sortKey="asking"
              sort={sort}
              setSort={setSort}
              className="pl-4 pr-2 text-right"
            />
            <th className="py-1 pl-4"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const grade = grades.get(p.id)
            const estSalary = marketSalary(p.position, p.ratings.overall, p.age)
            return (
              <tr key={p.id} className="border-b">
                <td className="py-1 pr-6 whitespace-nowrap">
                  {p.firstName} {p.lastName}
                  {p.contract === null && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-900 text-amber-200">
                      expiring
                    </span>
                  )}
                </td>
                <td className="py-1 px-2">{p.position}</td>
                <td className="py-1 px-2 text-right">{p.age}</td>
                <td className={`py-1 px-2 text-right ${overallColor(p.ratings.overall)} font-semibold`}>{p.ratings.overall}</td>
                <td className="py-1 px-2 text-right text-yellow-400 font-semibold">{p.ratings.potential}</td>
                <td className={`py-1 px-2 text-right font-semibold ${grade ? GRADE_COLORS[grade] : 'text-gray-600'}`}>
                  {grade ?? '-'}
                </td>
                <td className="py-1 pl-6 text-left text-gray-500 whitespace-nowrap">
                  {statTotals.has(p.id) ? statTotals.get(p.id) : '-'}
                </td>
                <td className="py-1 pl-4 pr-2 text-right whitespace-nowrap">
                  {p.contract ? formatMoney(p.contract.salary) : '-'}
                </td>
                <td className="py-1 px-2 text-right">{p.contract?.yearsLeft ?? '-'}</td>
                <td className="py-1 pl-4 pr-2 text-right whitespace-nowrap text-amber-300">
                  ~{formatMoney(estSalary)}
                </td>
                <td className="py-1 pl-4">
                  <div className="flex items-center gap-1 justify-end">
                    <select
                      className="border rounded text-xs px-1 py-1 bg-transparent"
                      value={yearsFor(p.id)}
                      onChange={(e) => {
                        const next = new Map(yearsByPlayer)
                        next.set(p.id, Number(e.target.value))
                        setYearsByPlayer(next)
                      }}
                    >
                      {[1, 2, 3, 4].map((y) => (
                        <option key={y} value={y} className="text-black">
                          {y}yr
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleResign(p.id)}
                      disabled={resigningId === p.id}
                      title={`Est. ${formatMoney(estSalary)}/yr`}
                      className="px-2 py-1 border rounded text-xs disabled:opacity-40 whitespace-nowrap"
                    >
                      {resigningId === p.id ? '...' : p.contract ? 'Extend' : 'Resign'}
                    </button>
                    <button
                      onClick={() => handleCut(p.id)}
                      disabled={cuttingId === p.id}
                      className="px-2 py-1 border rounded text-xs disabled:opacity-40"
                    >
                      {cuttingId === p.id ? '...' : 'Cut'}
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FreeAgencyView({
  leagueId,
  userTeamId,
  season,
  showDraftButton,
  onProceedToDraft,
}: {
  leagueId: number
  userTeamId: number
  season: number
  showDraftButton: boolean
  onProceedToDraft: () => void
}) {
  const roster = useLiveQuery(
    () => db.players.where('teamId').equals(userTeamId).toArray(),
    [userTeamId],
  )
  const freeAgents = useLiveQuery(
    () => db.players.filter((p) => p.teamId === null).toArray(),
    [leagueId],
  )
  const [signingId, setSigningId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [advancing, setAdvancing] = useState(false)
  const [autoFilling, setAutoFilling] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'overall', dir: 'desc' })
  const [positionFilter, setPositionFilter] = useState<Position | null>(null)

  if (!roster || !freeAgents) return <p className="text-sm text-gray-500">Loading free agents...</p>

  const needs = rosterNeeds(roster)
  const capSpace = computeCapSpace(roster)
  const rosterShort = MIN_ROSTER_SIZE - roster.length

  const filtered = positionFilter ? freeAgents.filter((p) => p.position === positionFilter) : freeAgents
  const sorted = sortRows(
    filtered,
    sort,
    (p, key) => {
      if (key === 'name') return `${p.firstName} ${p.lastName}`
      if (key === 'pos') return POSITION_ORDER.indexOf(p.position)
      if (key === 'age') return p.age
      if (key === 'pot') return p.ratings.potential
      if (key === 'asking') return estimateFreeAgentAsk(season, p).salary
      return p.ratings.overall
    },
    (p) => p.ratings.overall,
  )

  const handleSign = async (playerId: number) => {
    setError(null)
    setSigningId(playerId)
    try {
      await signFreeAgent(leagueId, playerId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSigningId(null)
    }
  }

  const handleProceed = async () => {
    setError(null)
    setAdvancing(true)
    try {
      await beginDraft(leagueId)
      onProceedToDraft()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdvancing(false)
    }
  }

  const handleAutoFill = async () => {
    setError(null)
    setAutoFilling(true)
    try {
      const { added } = await autoFillRoster(leagueId)
      if (added < rosterShort) {
        setError(
          `Signed ${added} player${added === 1 ? '' : 's'}, but couldn't fully fill the roster under the cap - cut a costlier player or try again next week.`,
        )
      }
    } finally {
      setAutoFilling(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          Roster{' '}
          <span className={rosterShort > 0 ? 'text-orange-400 font-semibold' : 'text-emerald-400 font-semibold'}>
            {roster.length}/{MIN_ROSTER_SIZE}
          </span>{' '}
          &middot; Cap space {formatMoney(capSpace)} &middot; Needs:{' '}
          {needs.length > 0 ? [...new Set(needs)].join(', ') : 'roster full'}
        </p>
        <div className="flex items-center gap-2">
          {rosterShort > 0 && (
            <button
              onClick={handleAutoFill}
              disabled={autoFilling}
              className="px-3 py-2 bg-orange-600 text-white rounded-md text-sm disabled:opacity-50"
            >
              {autoFilling ? 'Signing...' : `Auto-Fill Roster (+${rosterShort})`}
            </button>
          )}
          {showDraftButton && (
            <button
              onClick={handleProceed}
              disabled={advancing}
              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm disabled:opacity-50"
            >
              {advancing ? 'Starting draft...' : 'Enter the Draft'}
            </button>
          )}
        </div>
      </div>

      {rosterShort > 0 && (
        <p className="text-sm text-orange-400 mb-3">
          You need at least {MIN_ROSTER_SIZE} players to start the season - {rosterShort} short. Sign free agents
          below or use Auto-Fill Roster.
        </p>
      )}
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <TeamPositionPanel roster={roster} leagueId={leagueId} needs={needs} onSelectPosition={setPositionFilter} />
      {positionFilter && (
        <p className="text-xs text-blue-300 mb-2">
          Showing {positionFilter} only -{' '}
          <button className="underline" onClick={() => setPositionFilter(null)}>
            clear filter
          </button>
        </p>
      )}

      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-gray-400 border-b">
            <SortHeader label="Name" sortKey="name" sort={sort} setSort={setSort} />
            <SortHeader label="Pos" sortKey="pos" sort={sort} setSort={setSort} />
            <SortHeader label="Age" sortKey="age" sort={sort} setSort={setSort} className="text-right" />
            <SortHeader label="OVR" sortKey="overall" sort={sort} setSort={setSort} className="text-right" />
            <SortHeader label="POT" sortKey="pot" sort={sort} setSort={setSort} className="text-right" />
            <SortHeader label="Asking" sortKey="asking" sort={sort} setSort={setSort} className="text-right" />
            <th className="py-1"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const ask = estimateFreeAgentAsk(season, p)
            const tooExpensive = ask.salary > capSpace
            return (
              <tr key={p.id} className="border-b">
                <td className="py-1">
                  {p.firstName} {p.lastName}
                </td>
                <td className="py-1">{p.position}</td>
                <td className="py-1 text-right">{p.age}</td>
                <td className={`py-1 text-right ${overallColor(p.ratings.overall)} font-semibold`}>{p.ratings.overall}</td>
                <td className="py-1 text-right text-yellow-400 font-semibold">{p.ratings.potential}</td>
                <td className={`py-1 text-right whitespace-nowrap ${tooExpensive ? 'text-red-400' : ''}`}>
                  {formatMoney(ask.salary)}/yr &middot; {ask.years}yr
                </td>
                <td className="py-1 text-right">
                  <button
                    onClick={() => handleSign(p.id)}
                    disabled={signingId === p.id || !needs.includes(p.position) || tooExpensive}
                    title={tooExpensive ? 'Not enough cap space' : undefined}
                    className="px-2 py-1 border rounded text-xs disabled:opacity-40"
                  >
                    {signingId === p.id ? 'Signing...' : 'Sign'}
                  </button>
                </td>
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="text-sm text-gray-500 py-2">
                {positionFilter ? `No ${positionFilter} free agents available.` : 'No free agents available.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const COLLEGE_TIER_LABELS: Record<number, string> = {
  1: 'Blue Blood',
  2: 'Strong Program',
  3: 'Mid-Major',
  4: 'Small Program',
}

function DraftView({
  leagueId,
  userTeamId,
  teamName,
}: {
  leagueId: number
  userTeamId: number | null
  teamName: (id: number) => string
}) {
  const board = useLiveQuery(() => getDraftBoard(leagueId), [leagueId])
  const userRoster = useLiveQuery(
    (): Promise<Player[]> =>
      userTeamId != null ? db.players.where('teamId').equals(userTeamId).toArray() : Promise.resolve([]),
    [userTeamId],
  )
  const [pickingIndex, setPickingIndex] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'overall', dir: 'desc' })
  const [positionFilter, setPositionFilter] = useState<Position | null>(null)
  const [subTab, setSubTab] = useState<'board' | 'mypicks'>('board')
  const [simming, setSimming] = useState(false)

  if (board === undefined || !userRoster) return <p className="text-sm text-gray-500">Loading draft board...</p>
  if (board === null) return <p className="text-sm text-gray-500">No draft in progress.</p>

  const userNeeds = new Set(rosterNeeds(userRoster))
  const available = board.prospects.filter((p) => !board.pickedIndices.has(p.index))
  const filtered = positionFilter ? available.filter((p) => p.position === positionFilter) : available
  const sorted = sortRows(
    filtered,
    sort,
    (p, key) => {
      if (key === 'name') return `${p.firstName} ${p.lastName}`
      if (key === 'pos') return POSITION_ORDER.indexOf(p.position)
      if (key === 'age') return p.age
      if (key === 'college') return p.college
      if (key === 'pot') return p.ratings.potential
      return p.ratings.overall
    },
    (p) => p.ratings.overall,
  )
  const myPicks = userTeamId == null ? [] : board.log.filter((entry) => entry.teamId === userTeamId)

  const handlePick = async (prospectIndex: number) => {
    setError(null)
    setPickingIndex(prospectIndex)
    try {
      await makeUserDraftPick(leagueId, prospectIndex)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPickingIndex(null)
    }
  }

  const handleSimRest = async () => {
    if (
      !window.confirm(
        'Auto-draft the rest of the draft, including any picks still left for your team? This cannot be undone.',
      )
    ) {
      return
    }
    setError(null)
    setSimming(true)
    try {
      await simRestOfDraft(leagueId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSimming(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-sm text-gray-500">
          Round {board.round} of {board.totalRounds} &middot; Pick {board.pickInRound} of {board.picksPerRound}{' '}
          (#{board.pickNumber} overall)
          {board.currentTeamId != null && (
            <>
              {' '}
              &middot; On the clock:{' '}
              <span className={board.isUserTurn ? 'text-blue-300 font-semibold' : ''}>{teamName(board.currentTeamId)}</span>
            </>
          )}
          {board.isUserTurn && <span className="ml-2 text-green-400 font-semibold">Your pick!</span>}
        </p>
        <button
          onClick={handleSimRest}
          disabled={simming}
          className="px-3 py-1.5 border rounded-md text-xs whitespace-nowrap disabled:opacity-50"
          title="Auto-drafts every remaining pick, including yours, and moves straight to the regular season"
        >
          {simming ? 'Simming...' : 'Sim Rest of Draft'}
        </button>
      </div>

      {!board.isUserTurn && board.currentTeamId != null && (
        <p className="text-xs text-gray-600 mb-3">Waiting on {teamName(board.currentTeamId)} to pick...</p>
      )}

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {board.log.length > 0 && (
        <details className="mb-4">
          <summary className="text-xs text-gray-500 cursor-pointer">Draft results so far ({board.log.length})</summary>
          <ul className="text-xs text-gray-500 mt-2 space-y-0.5">
            {[...board.log].reverse().map((entry) => {
              const prospect = board.prospects[entry.prospectIndex]
              return (
                <li key={entry.pickNumber}>
                  Pick {entry.pickNumber}: {teamName(entry.teamId)} selected {prospect.firstName} {prospect.lastName} (
                  {prospect.position}, {prospect.ratings.overall} OVR, {prospect.college})
                </li>
              )
            })}
          </ul>
        </details>
      )}

      {userTeamId != null && (
        <TeamPositionPanel roster={userRoster} leagueId={leagueId} needs={[...userNeeds]} onSelectPosition={setPositionFilter} />
      )}

      {positionFilter && (
        <p className="text-xs text-blue-300 mb-2">
          Showing {positionFilter} only -{' '}
          <button className="underline" onClick={() => setPositionFilter(null)}>
            clear filter
          </button>
        </p>
      )}

      {userTeamId != null && (
        <div className="flex gap-4 border-b mb-4">
          <button
            onClick={() => setSubTab('board')}
            className={`px-1 py-2 text-sm border-b-2 -mb-px ${
              subTab === 'board' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
            }`}
          >
            Draft Board
          </button>
          <button
            onClick={() => setSubTab('mypicks')}
            className={`px-1 py-2 text-sm border-b-2 -mb-px ${
              subTab === 'mypicks' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
            }`}
          >
            My Picks ({myPicks.length})
          </button>
        </div>
      )}

      {subTab === 'mypicks' ? (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-gray-400 border-b">
              <th className="py-1 pr-4">Pick</th>
              <th className="py-1 pr-4">Name</th>
              <th className="py-1 pr-4">Pos</th>
              <th className="py-1 pr-4 text-right">Age</th>
              <th className="py-1 pr-4 text-right">OVR</th>
              <th className="py-1 pr-4 text-right">POT</th>
              <th className="py-1 pr-4">College</th>
            </tr>
          </thead>
          <tbody>
            {myPicks.map((entry) => {
              const prospect = board.prospects[entry.prospectIndex]
              const round = Math.floor((entry.pickNumber - 1) / board.picksPerRound) + 1
              return (
                <tr key={entry.pickNumber} className="border-b">
                  <td className="py-1 pr-4 whitespace-nowrap">
                    Rd {round}, Pick {entry.pickNumber}
                  </td>
                  <td className="py-1 pr-4 whitespace-nowrap">
                    {prospect.firstName} {prospect.lastName}
                  </td>
                  <td className="py-1 pr-4">{prospect.position}</td>
                  <td className="py-1 pr-4 text-right">{prospect.age}</td>
                  <td className={`py-1 pr-4 text-right ${overallColor(prospect.ratings.overall)} font-semibold`}>{prospect.ratings.overall}</td>
                  <td className="py-1 pr-4 text-right text-yellow-400 font-semibold">{prospect.ratings.potential}</td>
                  <td className="py-1 pr-4 whitespace-nowrap">{prospect.college}</td>
                </tr>
              )
            })}
            {myPicks.length === 0 && (
              <tr>
                <td colSpan={7} className="text-sm text-gray-500 py-2">
                  No picks made yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-gray-400 border-b">
              <SortHeader label="Name" sortKey="name" sort={sort} setSort={setSort} className="pr-4" />
              <SortHeader label="Pos" sortKey="pos" sort={sort} setSort={setSort} className="pr-4" />
              <SortHeader label="Age" sortKey="age" sort={sort} setSort={setSort} className="pr-4 text-right" />
              <SortHeader label="OVR" sortKey="overall" sort={sort} setSort={setSort} className="pr-4 text-right" />
              <SortHeader label="POT" sortKey="pot" sort={sort} setSort={setSort} className="pr-4 text-right" />
              <SortHeader label="College" sortKey="college" sort={sort} setSort={setSort} className="pr-4" />
              <th className="py-1 pr-4">College Stats</th>
              <th className="py-1 pr-4">Scouting Report</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const needed = userNeeds.has(p.position)
              return (
                <tr key={p.index} className="border-b align-top">
                  <td className="py-1 pr-4 whitespace-nowrap">
                    {p.firstName} {p.lastName}
                  </td>
                  <td className="py-1 pr-4">
                    {p.position}
                    {needed && (
                      <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-amber-900 text-amber-200">need</span>
                    )}
                  </td>
                  <td className="py-1 pr-4 text-right">{p.age}</td>
                  <td className={`py-1 pr-4 text-right ${overallColor(p.ratings.overall)} font-semibold`}>{p.ratings.overall}</td>
                  <td className="py-1 pr-4 text-right text-yellow-400 font-semibold">{p.ratings.potential}</td>
                  <td className="py-1 pr-4 whitespace-nowrap">
                    {p.college}
                    <div className="text-[10px] text-gray-600">{COLLEGE_TIER_LABELS[p.collegeTier]}</div>
                  </td>
                  <td className="py-1 pr-4 text-gray-500 whitespace-nowrap">{p.collegeStatLine}</td>
                  <td className="py-1 pr-4 text-gray-500 max-w-xs">{p.scoutingNote}</td>
                  <td className="py-1 text-right">
                    <button
                      onClick={() => handlePick(p.index)}
                      disabled={!board.isUserTurn || pickingIndex === p.index}
                      className="px-2 py-1 border rounded text-xs disabled:opacity-40 whitespace-nowrap"
                    >
                      {pickingIndex === p.index ? '...' : 'Draft'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} className="text-sm text-gray-500 py-2">
                  {positionFilter ? `No ${positionFilter} prospects left on the board.` : 'No prospects left on the board.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Highlights the user's own team wherever it shows up in a list/table. */
function userRowClass(teamId: number, userTeamId: number | null) {
  return teamId === userTeamId
    ? 'bg-blue-900/50 border-l-2 border-l-blue-400 text-blue-100 font-medium'
    : ''
}

function StandingsTable({
  teams,
  regularGames,
  teamName,
  userTeamId,
}: {
  teams: Team[]
  regularGames: GameResult[]
  teamName: (id: number) => string
  userTeamId: number | null
}) {
  return (
    <>
      {CONFERENCES.map((conf) => (
        <div key={conf} className="mb-8">
          <h2 className="text-lg font-medium mb-2">{conf}</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {DIVISIONS.map((div) => {
              const divTeams = teams.filter((t) => t.conference === conf && t.division === div)
              const standings = computeStandings(divTeams, regularGames)
              return (
                <div key={div}>
                  <h3 className="text-xs font-semibold text-gray-500 mb-1">
                    {conf} {div}
                  </h3>
                  <table className="w-full text-sm border-collapse">
                    <tbody>
                      {standings.map((row) => (
                        <tr
                          key={row.teamId}
                          className={`border-b ${userRowClass(row.teamId, userTeamId)}`}
                        >
                          <td className="py-1 pl-1">{teamName(row.teamId)}</td>
                          <td className="py-1 text-right w-10">{row.wins}</td>
                          <td className="py-1 text-right w-10">{row.losses}</td>
                          <td className="py-1 text-right w-10">{row.ties}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}

function PlayoffPictureView({
  teams,
  regularGames,
  playoffGamesByRound,
  userTeamId,
  teamName,
}: {
  teams: Team[]
  regularGames: GameResult[]
  playoffGamesByRound: Map<PlayoffRound, GameResult[]>
  userTeamId: number | null
  teamName: (id: number) => string
}) {
  const seedsByConf: Record<Conference, ReturnType<typeof computeConferenceSeeds>> = {
    AFC: computeConferenceSeeds(teams, regularGames, 'AFC'),
    NFC: computeConferenceSeeds(teams, regularGames, 'NFC'),
  }

  const gameRow = (g: GameResult) => (
    <li key={g.id} className={`text-sm border-b py-1 px-1 rounded ${userRowClass(g.homeTeamId, userTeamId) || userRowClass(g.awayTeamId, userTeamId)}`}>
      <span className={g.awayTeamId === userTeamId ? 'font-semibold' : ''}>
        {teamName(g.awayTeamId)} {g.awayScore}
      </span>
      {' @ '}
      <span className={g.homeTeamId === userTeamId ? 'font-semibold' : ''}>
        {teamName(g.homeTeamId)} {g.homeScore}
      </span>
    </li>
  )

  return (
    <div>
      <h2 className="text-lg font-medium mb-2">Playoff Picture</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 mb-8">
        {CONFERENCES.map((conf) => (
          <div key={conf}>
            <h3 className="text-xs font-semibold text-gray-500 mb-1">{conf} Seeding</h3>
            <table className="w-full text-sm border-collapse">
              <tbody>
                {seedsByConf[conf].map((s) => (
                  <tr key={s.teamId} className={`border-b ${userRowClass(s.teamId, userTeamId)}`}>
                    <td className="py-1 pl-1 w-6 text-gray-400">{s.seed}</td>
                    <td className="py-1">
                      {teamName(s.teamId)}
                      {s.divisionWinner && <span className="text-gray-400 text-xs"> (div)</span>}
                    </td>
                    <td className="py-1 text-right w-16">
                      {s.wins}-{s.losses}
                      {s.ties ? `-${s.ties}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {ROUND_ORDER.map((round) => {
        const games = playoffGamesByRound.get(round) ?? []
        if (games.length === 0) return null
        return (
          <div key={round} className="mb-4">
            <h3 className="text-xs font-semibold text-gray-500 mb-1">{ROUND_LABELS[round]}</h3>
            <ul className="space-y-1">{games.map(gameRow)}</ul>
          </div>
        )
      })}
    </div>
  )
}

function simButtonLabel(phase: LeaguePhase, week: number, currentRound: PlayoffRound | null) {
  if (phase === 'complete') return 'Season Complete'
  if (phase === 'playoffs') return currentRound ? `Sim ${ROUND_LABELS[currentRound]}` : 'Sim Playoffs'
  return `Sim Week ${week}`
}

function LeagueHome({ leagueId, onReset }: { leagueId: number; onReset: () => void }) {
  const league = useLiveQuery(() => db.leagues.get(leagueId), [leagueId])
  const teams = useLiveQuery(() => db.teams.toArray(), [])
  const games = useLiveQuery(() => db.games.where({ leagueId }).toArray(), [leagueId])
  const [simming, setSimming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [tab, setTab] = useState<'league' | 'roster' | 'gamereport' | 'trade' | 'freeagents' | 'stats' | 'history'>(
    'league',
  )

  const teamName = (id: number) => {
    const t = teams?.find((t) => t.id === id)
    return t ? `${t.region} ${t.name}` : `Team ${id}`
  }

  const handleSimWeek = async () => {
    setSimming(true)
    try {
      await simWeek(leagueId)
    } finally {
      setSimming(false)
    }
  }

  const handleAdvanceSeason = async () => {
    setAdvancing(true)
    try {
      await advanceToFreeAgency(leagueId)
    } finally {
      setAdvancing(false)
    }
  }

  const handleReset = async () => {
    if (!confirm(`Delete "${league?.name ?? 'this league'}" and start over? This cannot be undone.`)) {
      return
    }
    setResetting(true)
    try {
      await deleteLeague(leagueId)
      onReset()
    } finally {
      setResetting(false)
    }
  }

  if (!league || !teams || !games) return <p className="p-8">Loading league...</p>

  const seasonGames = games.filter((g) => g.season === league.season)
  const regularGames = seasonGames.filter((g) => g.round === undefined)
  const playoffGamesByRound = new Map<PlayoffRound, GameResult[]>()
  for (const round of ROUND_ORDER) {
    playoffGamesByRound.set(round, seasonGames.filter((g) => g.round === round))
  }
  const nextPlayoffRound =
    ROUND_ORDER.find((r) => (playoffGamesByRound.get(r)?.length ?? 0) === 0) ?? null

  return (
    <div className="max-w-7xl mx-auto p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">{league.name}</h1>
          <p className="text-sm text-gray-500">
            Season {league.season} &middot;{' '}
            {league.phase === 'regular'
              ? `Week ${league.week} of ${league.regularSeasonWeeks}`
              : league.phase === 'playoffs'
                ? 'Playoffs'
                : league.phase === 'resign'
                  ? 'Manage Roster'
                  : league.phase === 'freeagency'
                    ? 'Free Agency'
                    : league.phase === 'draft'
                      ? 'Draft'
                      : 'Complete'}
            {league.userTeamId != null && <> &middot; Your team: {teamName(league.userTeamId)}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {league.phase === 'complete' ? (
            <button
              onClick={handleAdvanceSeason}
              disabled={advancing}
              className="px-4 py-2 bg-green-600 text-white rounded-md disabled:opacity-50"
            >
              {advancing ? 'Advancing...' : `Start ${league.season + 1} Offseason`}
            </button>
          ) : league.phase === 'freeagency' || league.phase === 'resign' || league.phase === 'draft' ? null : (
            <button
              onClick={handleSimWeek}
              disabled={simming}
              className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:opacity-50"
            >
              {simming ? 'Simming...' : simButtonLabel(league.phase, league.week, nextPlayoffRound)}
            </button>
          )}
          <button
            onClick={handleReset}
            disabled={resetting}
            className="px-4 py-2 border rounded-md text-sm disabled:opacity-50"
          >
            {resetting ? 'Resetting...' : 'Reset League'}
          </button>
        </div>
      </div>

      {league.phase === 'complete' && league.champTeamId != null && (
        <div className="mb-6 border border-amber-700 rounded-md px-4 py-3 bg-amber-900/40 text-amber-200 text-sm font-medium">
          🏆 {teamName(league.champTeamId)} won the Super Bowl!
          {league.champTeamId === league.userTeamId && ' (that\'s you!)'}
        </div>
      )}

      {league.phase === 'resign' && league.userTeamId != null ? (
        <>
          <h2 className="text-lg font-medium mb-2">Manage Roster</h2>
          <ResignView
            leagueId={leagueId}
            userTeamId={league.userTeamId}
            season={league.season}
            onOpenFreeAgency={() => setTab('league')}
          />
        </>
      ) : league.phase === 'freeagency' && league.userTeamId != null ? (
        <>
          <h2 className="text-lg font-medium mb-2">Free Agency</h2>
          <FreeAgencyView
            leagueId={leagueId}
            userTeamId={league.userTeamId}
            season={league.season}
            showDraftButton
            onProceedToDraft={() => setTab('league')}
          />
        </>
      ) : league.phase === 'draft' ? (
        <>
          <h2 className="text-lg font-medium mb-2">Draft</h2>
          <DraftView leagueId={leagueId} userTeamId={league.userTeamId} teamName={teamName} />
        </>
      ) : (
        <>
          <div className="flex gap-4 border-b mb-6">
            <button
              onClick={() => setTab('league')}
              className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                tab === 'league' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
              }`}
            >
              League
            </button>
            {league.userTeamId != null && (
              <button
                onClick={() => setTab('roster')}
                className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                  tab === 'roster' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
                }`}
              >
                My Roster
              </button>
            )}
            {league.userTeamId != null && (
              <button
                onClick={() => setTab('gamereport')}
                className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                  tab === 'gamereport' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
                }`}
              >
                Game Report
              </button>
            )}
            {league.userTeamId != null && (
              <button
                onClick={() => setTab('trade')}
                className={`px-1 py-2 text-sm border-b-2 -mb-px flex items-center gap-1.5 ${
                  tab === 'trade' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
                }`}
              >
                Trade
                {(league.pendingTradeOffers?.length ?? 0) > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold">
                    {league.pendingTradeOffers?.length}
                  </span>
                )}
              </button>
            )}
            {league.userTeamId != null && (
              <button
                onClick={() => setTab('freeagents')}
                className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                  tab === 'freeagents' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
                }`}
              >
                Free Agents
              </button>
            )}
            <button
              onClick={() => setTab('stats')}
              className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                tab === 'stats' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
              }`}
            >
              Stat Leaders
            </button>
            <button
              onClick={() => setTab('history')}
              className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                tab === 'history' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
              }`}
            >
              History
            </button>
          </div>

          {tab === 'roster' && league.userTeamId != null && (
            <RosterView teamId={league.userTeamId} leagueId={leagueId} season={league.season} editable />
          )}
          {tab === 'gamereport' && league.userTeamId != null && (
            <GameReportView
              leagueId={leagueId}
              userTeamId={league.userTeamId}
              season={league.season}
              teamName={teamName}
            />
          )}
          {tab === 'trade' && league.userTeamId != null && (
            <TradeView leagueId={leagueId} userTeamId={league.userTeamId} season={league.season} teamName={teamName} />
          )}
          {tab === 'freeagents' && league.userTeamId != null && (
            <FreeAgencyView
              leagueId={leagueId}
              userTeamId={league.userTeamId}
              season={league.season}
              showDraftButton={false}
              onProceedToDraft={() => {}}
            />
          )}
          {tab === 'stats' && (
            <StatsLeadersView leagueId={leagueId} season={league.season} userTeamId={league.userTeamId} />
          )}
          {tab === 'history' && (
            <HistoryView leagueId={leagueId} userTeamId={league.userTeamId} teamName={teamName} />
          )}

          {tab === 'league' && (
            <>
              {league.phase === 'playoffs' || league.phase === 'complete' ? (
                <PlayoffPictureView
                  teams={teams}
                  regularGames={regularGames}
                  playoffGamesByRound={playoffGamesByRound}
                  userTeamId={league.userTeamId}
                  teamName={teamName}
                />
              ) : (
                <>
                  <h2 className="text-lg font-medium mb-2">Standings</h2>
                  <StandingsTable
                    teams={teams}
                    regularGames={regularGames}
                    teamName={teamName}
                    userTeamId={league.userTeamId}
                  />
                </>
              )}

              <h2 className="text-lg font-medium mb-2">Results</h2>
              <ul className="space-y-1">
                {[...regularGames].reverse().map((g) => (
                  <li
                    key={g.id}
                    className={`text-sm border-b py-1 px-1 rounded ${
                      userRowClass(g.homeTeamId, league.userTeamId) ||
                      userRowClass(g.awayTeamId, league.userTeamId)
                    }`}
                  >
                    Wk{g.week}: {teamName(g.awayTeamId)} {g.awayScore} @ {teamName(g.homeTeamId)}{' '}
                    {g.homeScore}
                  </li>
                ))}
                {regularGames.length === 0 && (
                  <li className="text-sm text-gray-500">No games simmed yet.</li>
                )}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}

function NewLeague({ onCreated }: { onCreated: (id: number) => void }) {
  const [name, setName] = useState('My Dynasty')
  const [teamIndex, setTeamIndex] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [seed, setSeed] = useState(() => Date.now())

  const previews = useMemo(() => previewLeagueTeams(seed), [seed])

  const handleCreate = async () => {
    if (teamIndex == null) return
    setCreating(true)
    try {
      const id = await createLeague(name, teamIndex, seed)
      onCreated(id)
    } finally {
      setCreating(false)
    }
  }

  const selected = teamIndex != null ? previews[teamIndex] : null

  return (
    <div className="max-w-3xl mx-auto p-8 text-center">
      <h1 className="text-2xl font-semibold mb-4">Dynasty</h1>
      <input
        className="border rounded-md px-3 py-2 w-full mb-3"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="League name"
      />

      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-gray-500 text-left">
          Pick your team - every team starts at a different point (age, talent, cap space).
        </p>
        <button
          onClick={() => {
            setSeed(Date.now())
            setTeamIndex(null)
          }}
          className="text-xs text-blue-400 underline shrink-0 ml-2"
        >
          Reroll league
        </button>
      </div>

      <div className="max-h-96 overflow-y-auto border rounded-md p-3 mb-4">
        {CONFERENCES.map((conf) => (
          <div key={conf} className="mb-3 last:mb-0">
            <h3 className="text-xs font-semibold text-gray-500 mb-1 text-left">{conf}</h3>
            <div className="grid grid-cols-2 gap-2">
              {previews
                .filter((t) => t.conference === conf)
                .map((t) => (
                  <button
                    key={t.abbrev}
                    onClick={() => setTeamIndex(t.index)}
                    className={`border rounded-md px-3 py-2 text-sm text-left ${
                      teamIndex === t.index ? 'border-blue-600 ring-1 ring-blue-600' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {t.region} {t.name}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${OUTLOOK_STYLES[t.outlook]}`}
                      >
                        {OUTLOOK_LABELS[t.outlook]}
                      </span>
                    </div>
                    <span className="block text-xs text-gray-500 mt-1">
                      {t.conference} {t.division} &middot; {t.overall} OVR &middot; Age{' '}
                      {t.avgAge} &middot; {formatMoney(t.capSpace)} cap space
                    </span>
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <p className="text-sm text-gray-600 mb-3">
          {selected.region} {selected.name}: {OUTLOOK_LABELS[selected.outlook]} &middot;{' '}
          {selected.overall} team overall &middot; {formatMoney(selected.capSpace)} available to
          spend
        </p>
      )}

      <button
        onClick={handleCreate}
        disabled={creating || teamIndex == null}
        className="px-4 py-2 bg-blue-600 text-white rounded-md w-full disabled:opacity-50"
      >
        {creating ? 'Creating league...' : teamIndex == null ? 'Pick a team first' : 'Start New League'}
      </button>
    </div>
  )
}

export default function App() {
  const leagues = useLiveQuery(() => db.leagues.toArray(), [])
  const [activeLeagueId, setActiveLeagueId] = useState<number | null>(null)

  const currentLeagueId = activeLeagueId ?? leagues?.[0]?.id ?? null

  if (currentLeagueId != null) {
    return <LeagueHome leagueId={currentLeagueId} onReset={() => setActiveLeagueId(null)} />
  }

  if (leagues == null) return null // still loading

  return <NewLeague onCreated={setActiveLeagueId} />
}
