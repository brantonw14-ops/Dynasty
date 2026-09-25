import 'fake-indexeddb/auto'
import { db } from '../src/db'
import { advanceToNextSeason, createLeague, deleteLeague, simWeek } from '../src/engine/league'

async function main() {
  const leagueId = await createLeague('Smoke Test League', 0, 42)

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

  const rosterCountBefore = await db.players.count()
  const offseasonResult = await advanceToNextSeason(leagueId)
  const rosterCountAfter = await db.players.count()
  const leagueAfterOffseason = await db.leagues.get(leagueId)

  console.log('offseason:', offseasonResult)
  console.log('roster count before/after:', rosterCountBefore, rosterCountAfter)
  console.log('season after offseason:', leagueAfterOffseason?.season, leagueAfterOffseason?.phase)

  if (leagueAfterOffseason?.phase !== 'regular' || leagueAfterOffseason.week !== 1) {
    throw new Error('League did not roll into a fresh regular season')
  }
  if (leagueAfterOffseason.season !== (league.season ?? 0) + 1) {
    throw new Error('Season number did not increment')
  }
  if (rosterCountAfter !== rosterCountBefore - offseasonResult.retiredCount + offseasonResult.draftedCount) {
    throw new Error('Roster count after offseason does not reconcile with retirements/draft picks')
  }

  // Play out the second season to make sure schedules/standings don't collide across seasons.
  for (let i = 0; i < 12; i++) {
    const league2 = await db.leagues.get(leagueId)
    if (!league2 || league2.phase === 'complete') break
    await simWeek(leagueId)
  }
  const league2 = await db.leagues.get(leagueId)
  const season2Games = await db.games
    .where('leagueId')
    .equals(leagueId)
    .and((g) => g.season === leagueAfterOffseason.season && g.round === undefined)
    .toArray()

  console.log('season 2 phase:', league2?.phase, 'season 2 regular games:', season2Games.length)

  if (league2?.phase !== 'complete') throw new Error('Second season did not complete')
  if (season2Games.length !== 28) throw new Error('Second season game count is wrong (season scoping bug)')

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
