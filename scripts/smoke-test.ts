import 'fake-indexeddb/auto'
import { db } from '../src/db'
import { createLeague, simWeek } from '../src/engine/league'

async function main() {
  const leagueId = await createLeague('Smoke Test League', 42)

  for (let i = 0; i < 12; i++) {
    const league = await db.leagues.get(leagueId)
    if (!league || league.phase === 'complete') break
    await simWeek(leagueId)
  }

  const league = await db.leagues.get(leagueId)
  const games = await db.games.where({ leagueId }).toArray()
  const regular = games.filter((g) => g.round === undefined)
  const semis = games.filter((g) => g.round === 'semifinal')
  const final = games.filter((g) => g.round === 'final')

  console.log('phase:', league?.phase)
  console.log('champTeamId:', league?.champTeamId)
  console.log('regular games:', regular.length, '(expected 28 for 8 teams round robin)')
  console.log('semifinal games:', semis.length, '(expected 2)')
  console.log('final games:', final.length, '(expected 1)')

  if (league?.phase !== 'complete') throw new Error('League did not reach complete phase')
  if (regular.length !== 28) throw new Error('Unexpected regular season game count')
  if (semis.length !== 2) throw new Error('Unexpected semifinal game count')
  if (final.length !== 1) throw new Error('Unexpected final game count')
  if (league.champTeamId == null) throw new Error('No champion set')

  console.log('OK: smoke test passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
