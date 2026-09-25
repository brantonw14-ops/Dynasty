import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db } from './db'
import { createLeague, simWeek } from './engine/league'

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

  if (!league) return <p className="p-8">Loading league...</p>

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{league.name}</h1>
          <p className="text-sm text-gray-500">
            Season {league.season} &middot; Week {league.week}
          </p>
        </div>
        <button
          onClick={handleSimWeek}
          disabled={simming}
          className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:opacity-50"
        >
          {simming ? 'Simming...' : `Sim Week ${league.week}`}
        </button>
      </div>

      <h2 className="text-lg font-medium mb-2">Teams</h2>
      <ul className="grid grid-cols-2 gap-2 mb-8">
        {teams?.map((t) => (
          <li key={t.id} className="border rounded-md px-3 py-2 text-sm">
            {t.region} {t.name} ({t.abbrev})
          </li>
        ))}
      </ul>

      <h2 className="text-lg font-medium mb-2">Results</h2>
      <ul className="space-y-1">
        {[...(games ?? [])].reverse().map((g) => (
          <li key={g.id} className="text-sm border-b py-1">
            Wk{g.week}: {teamName(g.awayTeamId)} {g.awayScore} @ {teamName(g.homeTeamId)}{' '}
            {g.homeScore}
          </li>
        ))}
        {games?.length === 0 && <li className="text-sm text-gray-500">No games simmed yet.</li>}
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
