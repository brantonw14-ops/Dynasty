import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db } from './db'
import { createLeague, regularSeasonWeeks, simWeek } from './engine/league'
import { computeStandings } from './engine/standings'
import type { LeaguePhase } from './types'

function simButtonLabel(phase: LeaguePhase, week: number, hasSemis: boolean) {
  if (phase === 'complete') return 'Season Complete'
  if (phase === 'playoffs') return hasSemis ? 'Sim Championship' : 'Sim Playoffs'
  return `Sim Week ${week}`
}

function LeagueHome({ leagueId }: { leagueId: number }) {
  const league = useLiveQuery(() => db.leagues.get(leagueId), [leagueId])
  const teams = useLiveQuery(() => db.teams.toArray(), [])
  const games = useLiveQuery(() => db.games.where({ leagueId }).toArray(), [leagueId])
  const [simming, setSimming] = useState(false)

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

  if (!league || !teams || !games) return <p className="p-8">Loading league...</p>

  const regularGames = games.filter((g) => g.round === undefined)
  const semiGames = games.filter((g) => g.round === 'semifinal')
  const finalGame = games.find((g) => g.round === 'final')
  const standings = computeStandings(teams, regularGames)
  const totalWeeks = regularSeasonWeeks(teams.length)

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{league.name}</h1>
          <p className="text-sm text-gray-500">
            Season {league.season} &middot;{' '}
            {league.phase === 'regular'
              ? `Week ${league.week} of ${totalWeeks}`
              : league.phase === 'playoffs'
                ? 'Playoffs'
                : 'Complete'}
          </p>
        </div>
        <button
          onClick={handleSimWeek}
          disabled={simming || league.phase === 'complete'}
          className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:opacity-50"
        >
          {simming ? 'Simming...' : simButtonLabel(league.phase, league.week, semiGames.length > 0)}
        </button>
      </div>

      {league.phase === 'complete' && league.champTeamId != null && (
        <div className="mb-6 border rounded-md px-4 py-3 bg-yellow-50 text-sm font-medium">
          🏆 {teamName(league.champTeamId)} won the championship!
        </div>
      )}

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
                Semifinal: {teamName(g.awayTeamId)} {g.awayScore} @ {teamName(g.homeTeamId)}{' '}
                {g.homeScore}
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
    </div>
  )
}

function NewLeague({ onCreated }: { onCreated: (id: number) => void }) {
  const [name, setName] = useState('My Dynasty')
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    setCreating(true)
    try {
      const id = await createLeague(name)
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
    return <LeagueHome leagueId={currentLeagueId} />
  }

  if (leagues == null) return null // still loading

  return <NewLeague onCreated={setActiveLeagueId} />
}
