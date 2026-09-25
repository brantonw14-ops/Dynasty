import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from './db'
import {
  advanceToFreeAgency,
  createLeague,
  cutPlayer,
  deleteLeague,
  getSeasonHistory,
  moveDepthChart,
  openFreeAgency,
  previewLeagueTeams,
  proceedToDraft,
  proposeTrade,
  resignPlayer,
  signFreeAgent,
  simWeek,
  type TeamPreview,
} from './engine/league'
import { computeCapSpace } from './engine/freeAgency'
import { computePositionOverall, computeTeamOverall, POSITION_ATTRIBUTES, rosterNeeds } from './engine/players'
import { marketSalary } from './engine/salary'
import { gradeSeasonPerformance, type SeasonGrade } from './engine/seasonPerformance'
import { computeConferenceSeeds, computeStandings } from './engine/standings'
import type { Conference, Division, GameResult, LeaguePhase, Player, PlayoffRound, Position, Team } from './types'

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

function formatMoney(n: number) {
  return `$${(n / 1_000_000).toFixed(1)}M`
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
    return `${t.passCompletions}/${t.passAttempts}, ${t.passYards} yds, ${t.passTDs} TD, ${t.interceptions} INT${t.rushYards > 0 ? ` · ${t.rushYards} rush yds` : ''}`
  }
  if (pos === 'RB' && (t.rushYards > 0 || t.rushTDs > 0 || t.recYards > 0)) {
    return `${t.rushYards} rush yds, ${t.rushTDs} TD${t.recYards > 0 ? ` · ${t.recYards} rec yds` : ''}`
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
    return `${rating} QBR allowed, ${t.passBreakups} PBU, ${t.defInterceptions} INT, ${t.yardsAllowed} yds allowed`
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

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        {roster.length} players &middot; Team overall {teamOverall} &middot; Cap space {formatMoney(computeCapSpace(roster))}
        {roster.some((p) => p.injury) && (
          <> &middot; {roster.filter((p) => p.injury).length} injured</>
        )}
        {editable && <> &middot; Use the arrows to set your depth chart / starters</>}
      </p>

      {POSITION_ORDER.map((pos) => {
        const players = byPosition.get(pos)
        if (!players || players.length === 0) return null
        const positionOverall = Math.round(computePositionOverall(players))
        const attrLabels = POSITION_ATTRIBUTES[pos]
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
                  <th className="py-1 pr-6 min-w-[11rem]">Name</th>
                  <th className="py-1 px-2 text-right w-12">Age</th>
                  <th className="py-1 px-2 text-right w-12">OVR</th>
                  <th className="py-1 px-2 text-right w-12">POT</th>
                  <th className="py-1 px-2 text-right w-12" title={attrLabels[0]}>{abbrevLabel(attrLabels[0])}</th>
                  <th className="py-1 px-2 text-right w-12" title={attrLabels[1]}>{abbrevLabel(attrLabels[1])}</th>
                  <th className="py-1 px-2 text-right w-12" title={attrLabels[2]}>{abbrevLabel(attrLabels[2])}</th>
                  <th className="py-1 pl-4 pr-2 text-right w-20">Salary</th>
                  <th className="py-1 px-2 text-right w-12">Yrs</th>
                  <th className="py-1 pl-6 text-left">Season</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => (
                  <tr key={p.id} className="border-b">
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
                    <td className="py-1 pr-6 whitespace-nowrap">
                      {i === 0 && <span className="text-[10px] text-gray-500 mr-1">1st</span>}
                      {p.firstName} {p.lastName}
                      {p.injury && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-900 text-red-200">
                          {p.injury.description} · {p.injury.weeksRemaining}wk
                        </span>
                      )}
                    </td>
                    <td className="py-1 px-2 text-right">{p.age}</td>
                    <td className="py-1 px-2 text-right text-green-400 font-semibold">{p.ratings.overall}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

function TradeView({ userTeamId }: { userTeamId: number }) {
  const teams = useLiveQuery(() => db.teams.toArray(), [])
  const myRoster = useLiveQuery(
    () => db.players.where('teamId').equals(userTeamId).toArray(),
    [userTeamId],
  )
  const [otherTeamId, setOtherTeamId] = useState<number | null>(null)
  const [giveIds, setGiveIds] = useState<Set<number>>(new Set())
  const [getIds, setGetIds] = useState<Set<number>>(new Set())
  const [proposing, setProposing] = useState(false)
  const [result, setResult] = useState<{ accepted: boolean; reason: string } | null>(null)

  const otherRoster = useLiveQuery(
    (): Promise<Player[]> =>
      otherTeamId != null ? db.players.where('teamId').equals(otherTeamId).toArray() : Promise.resolve([]),
    [otherTeamId],
  )

  if (!teams || !myRoster) return <p className="text-sm text-gray-500">Loading...</p>

  const otherTeams = teams.filter((t) => t.id !== userTeamId)

  const toggle = (set: Set<number>, setFn: (s: Set<number>) => void, id: number) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFn(next)
  }

  const handlePropose = async () => {
    if (otherTeamId == null) return
    setProposing(true)
    setResult(null)
    try {
      const outcome = await proposeTrade(userTeamId, otherTeamId, [...giveIds], [...getIds])
      setResult(outcome)
      if (outcome.accepted) {
        setGiveIds(new Set())
        setGetIds(new Set())
      }
    } finally {
      setProposing(false)
    }
  }

  const renderRoster = (
    roster: Player[],
    selected: Set<number>,
    setFn: (s: Set<number>) => void,
  ) => (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-gray-400 border-b">
          <th className="py-1"></th>
          <th className="py-1">Name</th>
          <th className="py-1">Pos</th>
          <th className="py-1 text-right">OVR</th>
        </tr>
      </thead>
      <tbody>
        {[...roster]
          .sort((a, b) => b.ratings.overall - a.ratings.overall)
          .map((p) => (
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
              </td>
              <td className="py-1">{p.position}</td>
              <td className="py-1 text-right text-green-400 font-semibold">{p.ratings.overall}</td>
            </tr>
          ))}
      </tbody>
    </table>
  )

  return (
    <div>
      <p className="text-sm text-gray-500 mb-2 text-left">Trade with</p>
      <select
        className="border rounded-md px-3 py-2 text-sm mb-4"
        value={otherTeamId ?? ''}
        onChange={(e) => {
          setOtherTeamId(e.target.value ? Number(e.target.value) : null)
          setGiveIds(new Set())
          setGetIds(new Set())
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
              <h3 className="text-sm font-semibold mb-2">You give ({giveIds.size})</h3>
              {renderRoster(myRoster, giveIds, setGiveIds)}
            </div>
            <div>
              <h3 className="text-sm font-semibold mb-2">You get ({getIds.size})</h3>
              {renderRoster(otherRoster, getIds, setGetIds)}
            </div>
          </div>

          <button
            onClick={handlePropose}
            disabled={proposing || (giveIds.size === 0 && getIds.size === 0)}
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

  const sorted = [...roster].sort((a, b) => b.ratings.overall - a.ratings.overall)
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
            <th className="py-1 pr-6 min-w-[11rem]">Name</th>
            <th className="py-1 px-2">Pos</th>
            <th className="py-1 px-2 text-right">Age</th>
            <th className="py-1 px-2 text-right">OVR</th>
            <th className="py-1 px-2 text-right">Grade</th>
            <th className="py-1 pl-6 text-left">Last Season</th>
            <th className="py-1 pl-4 pr-2 text-right">Salary</th>
            <th className="py-1 px-2 text-right">Yrs Left</th>
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
                <td className="py-1 px-2 text-right text-green-400 font-semibold">{p.ratings.overall}</td>
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
  onProceedToDraft,
}: {
  leagueId: number
  userTeamId: number
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

  if (!roster || !freeAgents) return <p className="text-sm text-gray-500">Loading free agents...</p>

  const needs = rosterNeeds(roster)
  const capSpace = computeCapSpace(roster)
  const sorted = [...freeAgents].sort((a, b) => b.ratings.overall - a.ratings.overall)

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
    setAdvancing(true)
    try {
      await proceedToDraft(leagueId)
      onProceedToDraft()
    } finally {
      setAdvancing(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          Cap space {formatMoney(capSpace)} &middot; Needs:{' '}
          {needs.length > 0 ? [...new Set(needs)].join(', ') : 'roster full'}
        </p>
        <button
          onClick={handleProceed}
          disabled={advancing}
          className="px-4 py-2 bg-green-600 text-white rounded-md text-sm disabled:opacity-50"
        >
          {advancing ? 'Running draft...' : 'Proceed to Draft'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-gray-400 border-b">
            <th className="py-1">Name</th>
            <th className="py-1">Pos</th>
            <th className="py-1 text-right">Age</th>
            <th className="py-1 text-right">OVR</th>
            <th className="py-1"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.id} className="border-b">
              <td className="py-1">
                {p.firstName} {p.lastName}
              </td>
              <td className="py-1">{p.position}</td>
              <td className="py-1 text-right">{p.age}</td>
              <td className="py-1 text-right text-green-400 font-semibold">{p.ratings.overall}</td>
              <td className="py-1 text-right">
                <button
                  onClick={() => handleSign(p.id)}
                  disabled={signingId === p.id || !needs.includes(p.position)}
                  className="px-2 py-1 border rounded text-xs disabled:opacity-40"
                >
                  {signingId === p.id ? 'Signing...' : 'Sign'}
                </button>
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5} className="text-sm text-gray-500 py-2">
                No free agents available.
              </td>
            </tr>
          )}
        </tbody>
      </table>
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
  const [tab, setTab] = useState<'league' | 'roster' | 'trade' | 'stats' | 'history'>('league')

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
          ) : league.phase === 'freeagency' || league.phase === 'resign' ? null : (
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
            onProceedToDraft={() => setTab('league')}
          />
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
                onClick={() => setTab('trade')}
                className={`px-1 py-2 text-sm border-b-2 -mb-px ${
                  tab === 'trade' ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500'
                }`}
              >
                Trade
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
          {tab === 'trade' && league.userTeamId != null && <TradeView userTeamId={league.userTeamId} />}
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
