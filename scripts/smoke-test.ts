import 'fake-indexeddb/auto'
import { db } from '../src/db'
import { advanceToNextSeason, createLeague, deleteLeague, simWeek } from '../src/engine/league'

const MAX_WEEKS = 40

async function playSeason(leagueId: number) {
  for (let i = 0; i < MAX_WEEKS; i++) {
    const league = await db.leagues.get(leagueId)
    if (!league || league.phase === 'complete') break
    await simWeek(leagueId)
  }
}

async function assertSeasonSane(leagueId: number, season: number) {
  const teams = await db.teams.toArray()
  const games = await db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.season === season)
    .toArray()
  const regular = games.filter((g) => g.round === undefined)
  const wildcard = games.filter((g) => g.round === 'wildcard')
  const divisional = games.filter((g) => g.round === 'divisional')
  const conference = games.filter((g) => g.round === 'conference')
  const superbowl = games.filter((g) => g.round === 'superbowl')

  console.log(`season ${season}: regular=${regular.length} wildcard=${wildcard.length} ` +
    `divisional=${divisional.length} conference=${conference.length} superbowl=${superbowl.length}`)

  const gamesPerTeam = new Map<number, number>()
  for (const g of regular) {
    gamesPerTeam.set(g.homeTeamId, (gamesPerTeam.get(g.homeTeamId) ?? 0) + 1)
    gamesPerTeam.set(g.awayTeamId, (gamesPerTeam.get(g.awayTeamId) ?? 0) + 1)
  }
  if (gamesPerTeam.size !== teams.length) {
    throw new Error(`Expected all ${teams.length} teams to have regular season games`)
  }
  for (const [teamId, count] of gamesPerTeam) {
    if (count < 15 || count > 19) {
      throw new Error(`Team ${teamId} played ${count} regular season games (expected ~17)`)
    }
  }

  if (wildcard.length !== 6) throw new Error(`Expected 6 wild card games, got ${wildcard.length}`)
  if (divisional.length !== 4) throw new Error(`Expected 4 divisional games, got ${divisional.length}`)
  if (conference.length !== 2) throw new Error(`Expected 2 conference games, got ${conference.length}`)
  if (superbowl.length !== 1) throw new Error(`Expected 1 Super Bowl game, got ${superbowl.length}`)
}

async function main() {
  const leagueId = await createLeague('Smoke Test League', 0, 42)

  const teamCount = await db.teams.count()
  console.log('teams:', teamCount, '(expected 32)')
  if (teamCount !== 32) throw new Error('Expected 32 NFL teams')

  await playSeason(leagueId)

  const league = await db.leagues.get(leagueId)
  if (league?.phase !== 'complete') throw new Error('League did not reach complete phase')
  if (league.champTeamId == null) throw new Error('No champion set')
  await assertSeasonSane(leagueId, league.season)

  console.log('OK: season 1 smoke test passed')

  const ratingsBefore = new Map(
    (await db.players.toArray()).map((p) => [p.id, p.ratings.overall]),
  )

  const rosterCountBefore = await db.players.count()
  const offseasonResult = await advanceToNextSeason(leagueId)
  const rosterCountAfter = await db.players.count()

  const survivors = await db.players.toArray()
  const changed = survivors.filter(
    (p) => ratingsBefore.has(p.id) && ratingsBefore.get(p.id) !== p.ratings.overall,
  )
  console.log(
    'progression: ',
    changed.length,
    'of',
    survivors.filter((p) => ratingsBefore.has(p.id)).length,
    'returning players changed overall rating',
  )
  if (changed.length === 0) throw new Error('No player ratings changed during progression')
  const leagueAfterOffseason = await db.leagues.get(leagueId)

  console.log('offseason:', offseasonResult)
  console.log('roster count before/after:', rosterCountBefore, rosterCountAfter)
  console.log('season after offseason:', leagueAfterOffseason?.season, leagueAfterOffseason?.phase)

  if (leagueAfterOffseason?.phase !== 'regular' || leagueAfterOffseason.week !== 1) {
    throw new Error('League did not roll into a fresh regular season')
  }
  if (leagueAfterOffseason.season !== league.season + 1) {
    throw new Error('Season number did not increment')
  }
  if (
    rosterCountAfter !==
    rosterCountBefore - offseasonResult.retiredCount + offseasonResult.draftedCount
  ) {
    throw new Error('Roster count after offseason does not reconcile with retirements/draft picks')
  }

  await playSeason(leagueId)
  const league2 = await db.leagues.get(leagueId)
  if (league2?.phase !== 'complete') throw new Error('Second season did not complete')
  await assertSeasonSane(leagueId, leagueAfterOffseason.season)

  console.log('OK: multi-season smoke test passed')

  await deleteLeague(leagueId)
  const remainingLeagues = await db.leagues.count()
  const remainingTeams = await db.teams.count()
  const remainingPlayers = await db.players.count()
  const remainingGames = await db.games.count()
  const remainingSchedule = await db.schedule.count()

  console.log('after delete:', {
    remainingLeagues,
    remainingTeams,
    remainingPlayers,
    remainingGames,
    remainingSchedule,
  })

  if (
    remainingLeagues !== 0 ||
    remainingTeams !== 0 ||
    remainingPlayers !== 0 ||
    remainingGames !== 0 ||
    remainingSchedule !== 0
  ) {
    throw new Error('deleteLeague did not fully clean up')
  }

  console.log('OK: delete cleanup passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
