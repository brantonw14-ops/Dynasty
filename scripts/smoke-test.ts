import 'fake-indexeddb/auto'
import { db } from '../src/db'
import {
  advanceToFreeAgency,
  createLeague,
  deleteLeague,
  previewLeagueTeams,
  proceedToDraft,
  proposeTrade,
  signFreeAgent,
  simWeek,
} from '../src/engine/league'
import { MIN_OVERALL } from '../src/engine/players'
import { computeStandings } from '../src/engine/standings'
import { playerValue } from '../src/engine/trades'

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
  const gamesPerWeek = new Map<number, number>()
  for (const g of regular) {
    gamesPerTeam.set(g.homeTeamId, (gamesPerTeam.get(g.homeTeamId) ?? 0) + 1)
    gamesPerTeam.set(g.awayTeamId, (gamesPerTeam.get(g.awayTeamId) ?? 0) + 1)
    gamesPerWeek.set(g.week, (gamesPerWeek.get(g.week) ?? 0) + 1)
  }
  if (gamesPerTeam.size !== teams.length) {
    throw new Error(`Expected all ${teams.length} teams to have regular season games`)
  }
  for (const [teamId, count] of gamesPerTeam) {
    if (count !== 17) {
      throw new Error(`Team ${teamId} played ${count} regular season games (expected exactly 17)`)
    }
  }
  for (const [week, count] of gamesPerWeek) {
    if (count < 14) {
      throw new Error(`Week ${week} only had ${count} games - a straggling/thin week (expected >=14)`)
    }
  }

  if (wildcard.length !== 6) throw new Error(`Expected 6 wild card games, got ${wildcard.length}`)
  if (divisional.length !== 4) throw new Error(`Expected 4 divisional games, got ${divisional.length}`)
  if (conference.length !== 2) throw new Error(`Expected 2 conference games, got ${conference.length}`)
  if (superbowl.length !== 1) throw new Error(`Expected 1 Super Bowl game, got ${superbowl.length}`)

  const stats = await db.playerGameStats
    .where('[leagueId+season]')
    .equals([leagueId, season])
    .toArray()
  const totalGames = regular.length + wildcard.length + divisional.length + conference.length + superbowl.length
  console.log(`season ${season}: ${stats.length} playerGameStats rows across ${totalGames} games`)
  if (stats.length === 0) throw new Error('No player game stats were recorded for this season')
  const passYardLeader = [...stats].sort((a, b) => b.passYards - a.passYards)[0]
  if (passYardLeader.passYards <= 0) throw new Error('Top passer has 0 pass yards - box score generation looks broken')
  const totalTDs = stats.reduce((s, r) => s + r.passTDs + r.rushTDs + r.recTDs, 0)
  if (totalTDs === 0) throw new Error('No touchdowns recorded all season - box score generation looks broken')
  console.log('OK: player game stats recorded with sane totals')

  // Regression test: a team's standings record must count ALL its games, not
  // just games against opponents who are also in the subset passed in (this
  // broke the division standings table, which computes each division's
  // 4-team standings against the full season's games).
  const fullStandings = computeStandings(teams, regular)
  const oneDivision = teams.filter(
    (t) => t.conference === teams[0].conference && t.division === teams[0].division,
  )
  const divisionStandings = computeStandings(oneDivision, regular)
  for (const divRow of divisionStandings) {
    const fullRow = fullStandings.find((r) => r.teamId === divRow.teamId)!
    const divTotal = divRow.wins + divRow.losses + divRow.ties
    const fullTotal = fullRow.wins + fullRow.losses + fullRow.ties
    if (divTotal !== fullTotal || divRow.wins !== fullRow.wins) {
      throw new Error(
        `Division-scoped standings for team ${divRow.teamId} (${divTotal} games, ${divRow.wins}W) ` +
          `don't match full-season standings (${fullTotal} games, ${fullRow.wins}W)`,
      )
    }
  }
  console.log('OK: division-scoped standings match full-season record for every team')
}

async function main() {
  const seed = 42

  await (async () => {
    const previews = previewLeagueTeams(seed)
    if (previews.length !== 32) throw new Error('Expected 32 team previews')
    const outlooks = new Set(previews.map((p) => p.outlook))
    console.log(
      'team preview outlooks:',
      Object.fromEntries([...outlooks].map((o) => [o, previews.filter((p) => p.outlook === o).length])),
    )
    if (outlooks.size < 2) throw new Error('Expected teams to vary in outlook, not all identical')
    for (const p of previews) {
      if (p.capSpace < 0) throw new Error(`Preview team ${p.abbrev} starts over the salary cap`)
    }
    console.log('OK: team previews vary and none start over the cap')
  })()

  const leagueId = await createLeague('Smoke Test League', 0, seed)

  const teamCount = await db.teams.count()
  console.log('teams:', teamCount, '(expected 32)')
  if (teamCount !== 32) throw new Error('Expected 32 NFL teams')

  await (async () => {
    const previews = previewLeagueTeams(seed)
    const teams = await db.teams.toArray()
    for (let i = 0; i < previews.length; i++) {
      const preview = previews[i]
      const team = teams[i]
      const roster = await db.players.where('teamId').equals(team.id).toArray()
      const actualOverall = Math.round(roster.reduce((s, p) => s + p.ratings.overall, 0) / roster.length)
      const actualCap = 224_000_000 - roster.reduce((s, p) => s + (p.contract?.salary ?? 0), 0)
      if (actualOverall !== preview.overall) {
        throw new Error(
          `Preview overall (${preview.overall}) for ${preview.abbrev} doesn't match actual (${actualOverall})`,
        )
      }
      if (Math.abs(actualCap - preview.capSpace) > 1) {
        throw new Error(
          `Preview cap space (${preview.capSpace}) for ${preview.abbrev} doesn't match actual (${actualCap})`,
        )
      }
    }
    console.log('OK: team preview exactly matches actual generated rosters for the same seed')
  })()

  await (async () => {
    const allPlayers = await db.players.toArray()
    const overalls = allPlayers.map((p) => p.ratings.overall)
    const minOverall = Math.min(...overalls)
    const maxOverall = Math.max(...overalls)
    console.log('overall rating range:', minOverall, '-', maxOverall, `(expected ${MIN_OVERALL}-99)`)
    if (minOverall < MIN_OVERALL) throw new Error(`Found a player rated below ${MIN_OVERALL} overall`)
    if (maxOverall > 99) throw new Error('Found a player rated above 99 overall')
    for (const p of allPlayers) {
      if (p.ratings.potential < p.ratings.overall) {
        throw new Error(`Player ${p.id} has potential (${p.ratings.potential}) below overall (${p.ratings.overall})`)
      }
    }

    // Salary must track overall: sort by overall and confirm salary is
    // non-decreasing in aggregate (allow a little noise, but a low-rated
    // player should never out-earn a much higher-rated one).
    const rostered = allPlayers.filter((p) => p.contract)
    const byOverall = [...rostered].sort((a, b) => a.ratings.overall - b.ratings.overall)
    const lowTier = byOverall.slice(0, Math.floor(byOverall.length * 0.2))
    const highTier = byOverall.slice(-Math.floor(byOverall.length * 0.2))
    const avgLowSalary = lowTier.reduce((s, p) => s + p.contract!.salary, 0) / lowTier.length
    const avgHighSalary = highTier.reduce((s, p) => s + p.contract!.salary, 0) / highTier.length
    console.log('avg salary: bottom 20% overall =', avgLowSalary, 'top 20% overall =', avgHighSalary)
    if (avgHighSalary <= avgLowSalary) {
      throw new Error('Top-rated players are not earning more than bottom-rated players on average')
    }
    console.log('OK: overall floor/ceiling and salary-tracks-overall checks passed')
  })()

  await (async () => {
    const startLeague = (await db.leagues.get(leagueId))!
    const teams = await db.teams.toArray()
    const otherTeam = teams.find((t) => t.id !== startLeague.userTeamId)!
    const myRoster = await db.players.where('teamId').equals(startLeague.userTeamId!).toArray()
    const theirRoster = await db.players.where('teamId').equals(otherTeam.id).toArray()

    const myWorst = [...myRoster].sort((a, b) => a.ratings.overall - b.ratings.overall)[0]
    const theirBest = [...theirRoster].sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
    const badTrade = await proposeTrade(startLeague.userTeamId!, otherTeam.id, [myWorst.id], [theirBest.id])
    if (badTrade.accepted) throw new Error('AI accepted a lopsided trade in the user\'s favor')

    let closest: { mine: (typeof myRoster)[number]; theirs: (typeof theirRoster)[number]; diff: number } | null =
      null
    for (const mine of myRoster) {
      for (const theirs of theirRoster) {
        if (mine.position !== theirs.position) continue
        const diff = Math.abs(playerValue(mine) - playerValue(theirs))
        if (!closest || diff < closest.diff) closest = { mine, theirs, diff }
      }
    }
    if (!closest) throw new Error('No comparable same-position players found to test trades with')

    const fairTrade = await proposeTrade(
      startLeague.userTeamId!,
      otherTeam.id,
      [closest.mine.id],
      [closest.theirs.id],
    )
    if (!fairTrade.accepted) {
      throw new Error(`Expected the closest-value trade to be accepted, got: ${fairTrade.reason}`)
    }
    const movedToThem = await db.players.get(closest.mine.id)
    const movedToMe = await db.players.get(closest.theirs.id)
    if (movedToThem?.teamId !== otherTeam.id || movedToMe?.teamId !== startLeague.userTeamId) {
      throw new Error('Accepted trade did not actually swap player teamIds')
    }
    console.log('OK: trade evaluation and execution work (rejects lopsided, accepts fair, swaps rosters)')
  })()

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
  const faResult = await advanceToFreeAgency(leagueId)
  const rosterCountAfterFA = await db.players.count()

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

  const leagueInFA = await db.leagues.get(leagueId)
  console.log('free agency:', faResult)
  console.log('season during free agency:', leagueInFA?.season, leagueInFA?.phase)
  if (leagueInFA?.phase !== 'freeagency') throw new Error('League did not enter free agency phase')
  if (leagueInFA.season !== league.season + 1) throw new Error('Season number did not increment')

  // The user's team should have been excluded from AI free agency, leaving
  // it with open roster needs to fill manually.
  if (leagueInFA.userTeamId == null) throw new Error('League has no user team')
  const userRosterBeforeSigning = await db.players
    .where('teamId')
    .equals(leagueInFA.userTeamId)
    .toArray()
  const stillFreeAgents = (await db.players.toArray()).filter((p) => p.teamId === null)
  console.log(
    'user roster size before signing:',
    userRosterBeforeSigning.length,
    'free agents available:',
    stillFreeAgents.length,
  )
  if (stillFreeAgents.length === 0) throw new Error('Expected some free agents left for the user to sign')

  const targetFA = stillFreeAgents.sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
  await signFreeAgent(leagueId, targetFA.id)
  const signedPlayer = await db.players.get(targetFA.id)
  if (signedPlayer?.teamId !== leagueInFA.userTeamId) {
    throw new Error('signFreeAgent did not actually assign the player to the user team')
  }
  if (!signedPlayer.contract) throw new Error('Signed player has no contract')
  console.log('OK: signed a free agent to the user team')

  const draftResult = await proceedToDraft(leagueId)
  const rosterCountAfter = await db.players.count()
  const leagueAfterOffseason = await db.leagues.get(leagueId)

  console.log('draft:', draftResult)
  console.log('roster count before/after FA+draft:', rosterCountBefore, rosterCountAfterFA, rosterCountAfter)
  console.log('season after offseason:', leagueAfterOffseason?.season, leagueAfterOffseason?.phase)

  if (leagueAfterOffseason?.phase !== 'regular' || leagueAfterOffseason.week !== 1) {
    throw new Error('League did not roll into a fresh regular season')
  }
  if (
    rosterCountAfter !==
    rosterCountBefore - faResult.retiredCount + draftResult.draftedCount
  ) {
    throw new Error('Roster count after offseason does not reconcile with retirements/draft picks')
  }

  await playSeason(leagueId)
  const league2 = await db.leagues.get(leagueId)
  if (league2?.phase !== 'complete') throw new Error('Second season did not complete')
  await assertSeasonSane(leagueId, leagueAfterOffseason.season)

  console.log('OK: multi-season smoke test passed')

  const statsBeforeDelete = await db.playerGameStats.count()
  console.log('playerGameStats rows before delete:', statsBeforeDelete)

  const deleteStart = Date.now()
  await deleteLeague(leagueId)
  const deleteMs = Date.now() - deleteStart
  console.log('deleteLeague took', deleteMs, 'ms')
  // Regression guard: a filtered bulkDelete over playerGameStats once hung
  // for minutes at this row count (cursor-walked one key at a time instead
  // of using table.clear()). A generous ceiling here still catches that
  // class of regression without being flaky on slower CI hardware.
  if (deleteMs > 10_000) {
    throw new Error(`deleteLeague took ${deleteMs}ms - expected well under 10s`)
  }

  const remainingLeagues = await db.leagues.count()
  const remainingTeams = await db.teams.count()
  const remainingPlayers = await db.players.count()
  const remainingGames = await db.games.count()
  const remainingSchedule = await db.schedule.count()
  const remainingStats = await db.playerGameStats.count()

  console.log('after delete:', {
    remainingLeagues,
    remainingTeams,
    remainingPlayers,
    remainingGames,
    remainingSchedule,
    remainingStats,
  })

  if (
    remainingLeagues !== 0 ||
    remainingTeams !== 0 ||
    remainingPlayers !== 0 ||
    remainingGames !== 0 ||
    remainingSchedule !== 0 ||
    remainingStats !== 0
  ) {
    throw new Error('deleteLeague did not fully clean up')
  }

  console.log('OK: delete cleanup passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
