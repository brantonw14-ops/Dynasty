import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from './db'
import {
  advanceToFreeAgency,
  createLeague,
  deleteLeague,
  previewLeagueTeams,
  proceedToDraft,
  proposeTrade,
  signFreeAgent,
  simWeek,
  type TeamPreview,
} from './engine/league'
import { computeCapSpace } from './engine/freeAgency'
import { rosterNeeds } from './engine/players'
import { computeStandings } from './engine/standings'
import type { Conference, Division, GameResult, LeaguePhase, Player, PlayoffRound, Position, Team } from './types'

const OUTLOOK_LABELS: Record<TeamPreview['outlook'], string> = {
  rebuilding: 'Rebuilding',
  contender: 'Playoff Contender',
  superbowl: 'Super Bowl Worthy',
}
const OUTLOOK_STYLES: Record<TeamPreview['outlook'], string> = {
  rebuilding: 'bg-gray-100 text-gray-600',
  contender: 'bg-blue-100 text-blue-700',
  superbowl: 'bg-amber-100 text-amber-800',
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

function RosterView({ teamId }: { teamId: number }) {
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const roster = useLiveQuery(() => db.players.where('teamId').equals(teamId).toArray(), [teamId])

  if (!team || !roster) return <p className="text-sm text-gray-500">Loading roster...</p>

  const byPosition = new Map<Position, Player[]>()
  for (const p of roster) {
    const list = byPosition.get(p.position) ?? []
    list.push(p)
    byPosition.set(p.position, list)
  }
  for (const list of byPosition.values()) {
    list.sort((a, b) => b.ratings.overall - a.ratings.overall)
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        {roster.length} players &middot; Cap space {formatMoney(team.capSpace)}
      </p>

      {POSITION_ORDER.map((pos) => {
        const players = byPosition.get(pos)
        if (!players || players.length === 0) return null
        return (
          <div key={pos} className="mb-6">
            <h2 className="text-sm font-semibold text-gray-500 mb-2">{pos}</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-gray-400 border-b">
                  <th className="py-1">Name</th>
                  <th className="py-1 text-right">Age</th>
                  <th className="py-1 text-right">OVR</th>
                  <th className="py-1 text-right">POT</th>
                  <th className="py-1 text-right">Salary</th>
                  <th className="py-1 text-right">Yrs</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id} className="border-b">
                    <td className="py-1">
                      {p.firstName} {p.lastName}
                    </td>
                    <td className="py-1 text-right">{p.age}</td>
                    <td className="py-1 text-right">{p.ratings.overall}</td>
                    <td className="py-1 text-right">{p.ratings.potential}</td>
                    <td className="py-1 text-right">
                      {p.contract ? formatMoney(p.contract.salary) : '-'}
                    </td>
                    <td className="py-1 text-right">{p.contract?.yearsLeft ?? '-'}</td>
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
              <td className="py-1 text-right">{p.ratings.overall}</td>
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
            <p className={`text-sm mt-3 ${result.accepted ? 'text-green-600' : 'text-red-600'}`}>
              {result.accepted ? 'Accepted: ' : 'Rejected: '}
              {result.reason}
            </p>
          )}
        </>
      )}
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

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

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
              <td className="py-1 text-right">{p.ratings.overall}</td>
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

function StandingsTable({
  teams,
  regularGames,
  teamName,
}: {
  teams: Team[]
  regularGames: GameResult[]
  teamName: (id: number) => string
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
                        <tr key={row.teamId} className="border-b">
                          <td className="py-1">{teamName(row.teamId)}</td>
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
  const [tab, setTab] = useState<'league' | 'roster' | 'trade'>('league')

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
    <div className="max-w-4xl mx-auto p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">{league.name}</h1>
          <p className="text-sm text-gray-500">
            Season {league.season} &middot;{' '}
            {league.phase === 'regular'
              ? `Week ${league.week} of ${league.regularSeasonWeeks}`
              : league.phase === 'playoffs'
                ? 'Playoffs'
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
          ) : league.phase === 'freeagency' ? null : (
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
        <div className="mb-6 border rounded-md px-4 py-3 bg-yellow-50 text-sm font-medium">
          🏆 {teamName(league.champTeamId)} won the Super Bowl!
        </div>
      )}

      {league.phase === 'freeagency' && league.userTeamId != null ? (
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
          </div>

          {tab === 'roster' && league.userTeamId != null && <RosterView teamId={league.userTeamId} />}
          {tab === 'trade' && league.userTeamId != null && <TradeView userTeamId={league.userTeamId} />}

          {tab === 'league' && (
            <>
              <h2 className="text-lg font-medium mb-2">Standings</h2>
              <StandingsTable teams={teams} regularGames={regularGames} teamName={teamName} />

              {ROUND_ORDER.some((r) => (playoffGamesByRound.get(r)?.length ?? 0) > 0) && (
                <div className="mb-8">
                  <h2 className="text-lg font-medium mb-2">Playoffs</h2>
                  {ROUND_ORDER.map((round) => {
                    const roundGames = playoffGamesByRound.get(round) ?? []
                    if (roundGames.length === 0) return null
                    return (
                      <div key={round} className="mb-3">
                        <h3 className="text-xs font-semibold text-gray-500 mb-1">
                          {ROUND_LABELS[round]}
                        </h3>
                        <ul className="space-y-1">
                          {roundGames.map((g) => (
                            <li key={g.id} className="text-sm border-b py-1">
                              {teamName(g.awayTeamId)} {g.awayScore} @ {teamName(g.homeTeamId)}{' '}
                              {g.homeScore}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}

              <h2 className="text-lg font-medium mb-2">Results</h2>
              <ul className="space-y-1">
                {[...regularGames].reverse().map((g) => (
                  <li key={g.id} className="text-sm border-b py-1">
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
          className="text-xs text-blue-600 underline shrink-0 ml-2"
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
