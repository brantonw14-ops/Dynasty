import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db } from './db'
import {
  advanceToNextSeason,
  createLeague,
  deleteLeague,
  regularSeasonWeeks,
  simWeek,
} from './engine/league'
import { computeStandings } from './engine/standings'
import { TEAM_PREVIEWS } from './engine/teams'
import type { LeaguePhase, Player, Position } from './types'

const POSITION_ORDER: Position[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P']

function formatMoney(n: number) {
  return `$${(n / 1_000_000).toFixed(1)}M`
}

function RosterView({ teamId }: { teamId: number }) {
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const roster = useLiveQuery(
    () => db.players.where('teamId').equals(teamId).toArray(),
    [teamId],
  )

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

function simButtonLabel(phase: LeaguePhase, week: number, hasSemis: boolean) {
  if (phase === 'complete') return 'Season Complete'
  if (phase === 'playoffs') return hasSemis ? 'Sim Championship' : 'Sim Playoffs'
  return `Sim Week ${week}`
}

function LeagueHome({ leagueId, onReset }: { leagueId: number; onReset: () => void }) {
  const league = useLiveQuery(() => db.leagues.get(leagueId), [leagueId])
  const teams = useLiveQuery(() => db.teams.toArray(), [])
  const games = useLiveQuery(() => db.games.where({ leagueId }).toArray(), [leagueId])
  const [simming, setSimming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [tab, setTab] = useState<'league' | 'roster'>('league')

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
      await advanceToNextSeason(leagueId)
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
  const semiGames = seasonGames.filter((g) => g.round === 'semifinal')
  const finalGame = seasonGames.find((g) => g.round === 'final')
  const standings = computeStandings(teams, regularGames)
  const totalWeeks = regularSeasonWeeks(teams.length)

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">{league.name}</h1>
          <p className="text-sm text-gray-500">
            Season {league.season} &middot;{' '}
            {league.phase === 'regular'
              ? `Week ${league.week} of ${totalWeeks}`
              : league.phase === 'playoffs'
                ? 'Playoffs'
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
              {advancing ? 'Advancing...' : `Advance to ${league.season + 1} Season`}
            </button>
          ) : (
            <button
              onClick={handleSimWeek}
              disabled={simming}
              className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:opacity-50"
            >
              {simming
                ? 'Simming...'
                : simButtonLabel(league.phase, league.week, semiGames.length > 0)}
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
          🏆 {teamName(league.champTeamId)} won the championship!
        </div>
      )}

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
      </div>

      {tab === 'roster' && league.userTeamId != null && <RosterView teamId={league.userTeamId} />}

      {tab === 'league' && (
        <>
          <h2 className="text-lg font-medium mb-2">Standings</h2>
          <table className="w-full text-sm mb-8 border-collapse">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-1">Team</th>
                <th className="py-1 text-right">W</th>
                <th className="py-1 text-right">L</th>
                <th className="py-1 text-right">T</th>
                <th className="py-1 text-right">PF</th>
                <th className="py-1 text-right">PA</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((row, i) => (
                <tr key={row.teamId} className="border-b">
                  <td className="py-1">
                    {i < 4 && league.phase !== 'regular' && (
                      <span className="text-xs text-gray-400 mr-1">#{i + 1}</span>
                    )}
                    {teamName(row.teamId)}
                  </td>
                  <td className="py-1 text-right">{row.wins}</td>
                  <td className="py-1 text-right">{row.losses}</td>
                  <td className="py-1 text-right">{row.ties}</td>
                  <td className="py-1 text-right">{row.pointsFor}</td>
                  <td className="py-1 text-right">{row.pointsAgainst}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {(semiGames.length > 0 || finalGame) && (
            <>
              <h2 className="text-lg font-medium mb-2">Playoffs</h2>
              <ul className="space-y-1 mb-8">
                {semiGames.map((g) => (
                  <li key={g.id} className="text-sm border-b py-1">
                    Semifinal: {teamName(g.awayTeamId)} {g.awayScore} @{' '}
                    {teamName(g.homeTeamId)} {g.homeScore}
                  </li>
                ))}
                {finalGame && (
                  <li className="text-sm border-b py-1 font-medium">
                    Championship: {teamName(finalGame.awayTeamId)} {finalGame.awayScore} @{' '}
                    {teamName(finalGame.homeTeamId)} {finalGame.homeScore}
                  </li>
                )}
              </ul>
            </>
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
    </div>
  )
}

function NewLeague({ onCreated }: { onCreated: (id: number) => void }) {
  const [name, setName] = useState('My Dynasty')
  const [teamIndex, setTeamIndex] = useState(0)
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    setCreating(true)
    try {
      const id = await createLeague(name, teamIndex)
      onCreated(id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-2xl font-semibold mb-4">Dynasty</h1>
      <input
        className="border rounded-md px-3 py-2 w-full mb-3"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="League name"
      />

      <p className="text-sm text-gray-500 mb-2 text-left">Pick your team</p>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {TEAM_PREVIEWS.map((t, i) => (
          <button
            key={t.abbrev}
            onClick={() => setTeamIndex(i)}
            className={`border rounded-md px-3 py-2 text-sm text-left ${
              teamIndex === i ? 'border-blue-600 ring-1 ring-blue-600' : ''
            }`}
          >
            {t.region} {t.name}
          </button>
        ))}
      </div>

      <button
        onClick={handleCreate}
        disabled={creating}
        className="px-4 py-2 bg-blue-600 text-white rounded-md w-full disabled:opacity-50"
      >
        {creating ? 'Creating league...' : 'Start New League'}
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
