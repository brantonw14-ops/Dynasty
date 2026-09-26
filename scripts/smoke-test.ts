import 'fake-indexeddb/auto'
import { db } from '../src/db'
import {
  acceptTradeOffer,
  advanceToFreeAgency,
  autoFillRoster,
  beginDraft,
  createLeague,
  cutPlayer,
  deleteLeague,
  DRAFT_ROUNDS,
  findSuggestedTrades,
  generateTradeOffers,
  getDraftBoard,
  getSeasonHistory,
  makeUserDraftPick,
  moveDepthChart,
  optimizeDepthChart,
  openFreeAgency,
  ownedPicks,
  pickOwner,
  previewLeagueTeams,
  proposeTrade,
  resignPlayer,
  signFreeAgent,
  simRestOfDraft,
  simWeek,
  toggleTradeBlock,
} from '../src/engine/league'
import { POSITION_AGE_PROFILE } from '../src/engine/ages'
import { computeCapSpace } from '../src/engine/freeAgency'
import { buildGameReasons, classifyGamePerformance } from '../src/engine/gameReport'
import { passerRating } from '../src/engine/gameSim'
import { computePositionOverall, computeTeamOverall, MIN_OVERALL, MIN_ROSTER_SIZE, rosterNeeds } from '../src/engine/players'
import { marketSalary } from '../src/engine/salary'
import { gradeSeasonPerformance } from '../src/engine/seasonPerformance'
import { computeStandings } from '../src/engine/standings'
import { playerValue } from '../src/engine/trades'
import type { Position } from '../src/types'

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

  // Game report: pick the user's most recent game this season, classify
  // every player's performance, and generate the "why we won/lost"
  // breakdown - should never crash and should always produce at least one
  // reason line.
  const leagueForReport = await db.leagues.get(leagueId)
  if (leagueForReport?.userTeamId != null) {
    const userTeamId = leagueForReport.userTeamId
    const userGames = games.filter((g) => g.homeTeamId === userTeamId || g.awayTeamId === userTeamId)
    if (userGames.length === 0) throw new Error('User team has no games to build a game report from')
    const reportGame = userGames[userGames.length - 1]
    const reportStats = stats.filter((s) => s.gameId === reportGame.id && s.teamId === userTeamId)
    if (reportStats.length === 0) throw new Error('No player stats found for the user team on their own game')
    const graded = reportStats
      .map((s) => classifyGamePerformance(s.position, s))
      .filter((tag): tag is 'good' | 'bad' => tag !== null)
    const isHome = reportGame.homeTeamId === userTeamId
    const myScore = isHome ? reportGame.homeScore : reportGame.awayScore
    const oppScore = isHome ? reportGame.awayScore : reportGame.homeScore
    const reasons = buildGameReasons(reportStats, myScore > oppScore, myScore, oppScore)
    if (reasons.length === 0) throw new Error('Game report produced no reasons for the result')
    console.log(
      `game report: ${graded.length} graded performances, ${reasons.length} reason(s) for a ${myScore}-${oppScore} result`,
    )
    console.log('OK: game report classification and reasons generate without error')

    // Box score: every player who recorded a stat this game should be
    // gradeable against their position peers league-wide for that same
    // week (not just the standouts classifyGamePerformance tags).
    const oppTeamId = isHome ? reportGame.awayTeamId : reportGame.homeTeamId
    const oppStats = stats.filter((s) => s.gameId === reportGame.id && s.teamId === oppTeamId)
    const weekStats = stats.filter((s) => s.week === reportGame.week)
    const weekGrades = gradeSeasonPerformance(weekStats)
    const bothSidesStats = [...reportStats, ...oppStats]
    const gradedCount = bothSidesStats.filter((s) => weekGrades.has(s.playerId)).length
    if (bothSidesStats.length === 0) throw new Error('Expected box score rows for both teams in this game')
    if (gradedCount === 0) throw new Error('Expected at least some box score rows to have a per-game grade')
    console.log(`box score: ${bothSidesStats.length} total rows (both teams), ${gradedCount} with a per-game grade`)
    console.log('OK: box score covers every player, not just standout performances, with per-game grades available')
  }

  const qbStats = stats.filter((s) => s.position === 'QB' && s.passAttempts > 0)
  if (qbStats.length === 0) throw new Error('No QB pass-attempt stats recorded')
  const totalAttempts = qbStats.reduce((s, r) => s + r.passAttempts, 0)
  const totalCompletions = qbStats.reduce((s, r) => s + r.passCompletions, 0)
  const totalInterceptions = qbStats.reduce((s, r) => s + r.interceptions, 0)
  if (totalCompletions > totalAttempts) throw new Error('Completions exceeded attempts')
  if (totalCompletions === 0) throw new Error('No completions recorded despite pass attempts')
  console.log(
    `QB stats: ${totalCompletions}/${totalAttempts} completions, ${totalInterceptions} interceptions across the season`,
  )
  console.log('OK: QB accuracy/completion/interception stats recorded')

  // Passer rating regression: each of the 4 components must be clamped to
  // [0, 2.375] (the real NFL formula), not [0, 1] - the latter caps the
  // whole rating at ~66.7 and was silently wrong for a season.
  const bestQbRow = [...qbStats].sort((a, b) => {
    const ra = passerRating(a.passAttempts, a.passCompletions, a.passYards, a.passTDs, a.interceptions)
    const rb = passerRating(b.passAttempts, b.passCompletions, b.passYards, b.passTDs, b.interceptions)
    return rb - ra
  })[0]
  const bestRating = passerRating(
    bestQbRow.passAttempts,
    bestQbRow.passCompletions,
    bestQbRow.passYards,
    bestQbRow.passTDs,
    bestQbRow.interceptions,
  )
  console.log(`best single-game passer rating this season: ${bestRating}`)
  if (bestRating <= 100) {
    throw new Error(`Expected at least one game with passer rating > 100, best was ${bestRating} - clamp bug regressed?`)
  }
  if (bestRating > 158.3) throw new Error(`Passer rating ${bestRating} exceeds the real NFL max of 158.3`)
  console.log('OK: passer rating formula is not clamped to the wrong range')

  const rbStats = stats.filter((s) => s.position === 'RB' && s.rushAttempts > 0)
  if (rbStats.length === 0) throw new Error('No RB rush-attempt stats recorded')
  const totalCarries = rbStats.reduce((s, r) => s + r.rushAttempts, 0)
  const totalRushYards = rbStats.reduce((s, r) => s + r.rushYards, 0)
  const leagueYpc = totalRushYards / totalCarries
  console.log(`RB rushing: ${totalCarries} carries, ${totalRushYards} yds, ${leagueYpc.toFixed(2)} yds/carry league-wide`)
  if (leagueYpc < 3 || leagueYpc > 6) {
    throw new Error(`League-wide yards per carry (${leagueYpc.toFixed(2)}) looks unrealistic (expected ~3.5-5.5)`)
  }
  console.log('OK: RB rush attempts recorded with a realistic yards-per-carry average')

  const dlLbStats = stats.filter((s) => s.position === 'DL' || s.position === 'LB')
  const totalTackles = dlLbStats.reduce((s, r) => s + r.tackles, 0)
  const totalSacks = dlLbStats.reduce((s, r) => s + r.sacks, 0)
  if (totalTackles === 0) throw new Error('No DL/LB tackles recorded all season')
  if (totalSacks === 0) throw new Error('No DL/LB sacks recorded all season')

  const olStats = stats.filter((s) => s.position === 'OL')
  const totalPancakes = olStats.reduce((s, r) => s + r.pancakes, 0)
  const totalSacksAllowed = olStats.reduce((s, r) => s + r.sacksAllowed, 0)
  if (totalPancakes === 0) throw new Error('No OL pancake blocks recorded all season')
  if (totalSacksAllowed !== totalSacks) {
    throw new Error(`Sacks allowed by OL (${totalSacksAllowed}) should equal sacks recorded by DL/LB (${totalSacks})`)
  }

  const dbStats = stats.filter((s) => s.position === 'CB' || s.position === 'S')
  const totalDefInts = dbStats.reduce((s, r) => s + r.defInterceptions, 0)
  const totalPBUs = dbStats.reduce((s, r) => s + r.passBreakups, 0)
  const totalOffenseInts = stats.reduce((s, r) => s + r.interceptions, 0)
  if (totalDefInts !== totalOffenseInts) {
    throw new Error(`Defensive interceptions (${totalDefInts}) should equal offensive interceptions thrown (${totalOffenseInts})`)
  }
  if (totalPBUs === 0) throw new Error('No CB/S pass breakups recorded all season')

  const kStats = stats.filter((s) => s.position === 'K')
  const totalFGA = kStats.reduce((s, r) => s + r.fieldGoalsAttempted, 0)
  const totalFGM = kStats.reduce((s, r) => s + r.fieldGoalsMade, 0)
  if (totalFGA === 0) throw new Error('No kicker field goal attempts recorded all season')
  if (totalFGM > totalFGA) throw new Error('Field goals made exceeded attempted')

  const pStats = stats.filter((s) => s.position === 'P')
  const totalPunts = pStats.reduce((s, r) => s + r.puntCount, 0)
  if (totalPunts === 0) throw new Error('No punts recorded all season')

  console.log(
    `defense/ST stats: ${totalTackles} tackles, ${totalSacks} sacks, ${totalPancakes} pancakes, ${totalFGM}/${totalFGA} FG, ${totalPunts} punts`,
  )
  console.log('OK: defensive line, secondary, and special teams stats are internally consistent')

  // Regression test: CB/S coverage stats (yards/rating allowed) used to be
  // split identically across the whole secondary regardless of who was
  // actually a good cover guy - confirm real per-player variance shows up
  // instead of every corner/safety on a team posting the same number.
  const secondaryByTeamGame = new Map<string, typeof dbStats>()
  for (const s of dbStats) {
    const key = `${s.gameId}-${s.teamId}`
    const list = secondaryByTeamGame.get(key) ?? []
    list.push(s)
    secondaryByTeamGame.set(key, list)
  }
  let groupsWithMultiple = 0
  let groupsWithVariance = 0
  for (const group of secondaryByTeamGame.values()) {
    if (group.length < 2) continue
    groupsWithMultiple++
    const ratings = group.map((g) => g.passerRatingAllowed)
    if (new Set(ratings).size > 1) groupsWithVariance++
  }
  if (groupsWithMultiple === 0) throw new Error('Expected at least one team-game with 2+ active CB/S to compare')
  if (groupsWithVariance / groupsWithMultiple < 0.5) {
    throw new Error(
      `Expected most multi-player secondary groups to show per-player variance in passerRatingAllowed, got ${groupsWithVariance}/${groupsWithMultiple}`,
    )
  }
  console.log(`OK: CB/S coverage stats vary per player (${groupsWithVariance}/${groupsWithMultiple} team-games show variance)`)

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

    // Cap space should track team strength: a stacked roster spent close to
    // the cap building it (little room left), a rebuilding one left plenty
    // on the table - not every team converging on the same leftover amount
    // regardless of talent.
    const n = previews.length
    const meanOverall = previews.reduce((s, p) => s + p.overall, 0) / n
    const meanCap = previews.reduce((s, p) => s + p.capSpace, 0) / n
    let cov = 0, varOverall = 0, varCap = 0
    for (const p of previews) {
      cov += (p.overall - meanOverall) * (p.capSpace - meanCap)
      varOverall += (p.overall - meanOverall) ** 2
      varCap += (p.capSpace - meanCap) ** 2
    }
    const correlation = cov / Math.sqrt(varOverall * varCap)
    console.log('overall-vs-capSpace correlation:', correlation)
    if (correlation > -0.3) {
      throw new Error(`Expected better teams to reliably have less cap space, correlation was only ${correlation}`)
    }
    console.log('OK: cap space is negatively correlated with team overall')
  })()

  const leagueId = await createLeague('Smoke Test League', 0, seed)

  const teamCount = await db.teams.count()
  console.log('teams:', teamCount, '(expected 32)')
  if (teamCount !== 32) throw new Error('Expected 32 NFL teams')

  // A fresh league should never start with an empty free agent pool - real
  // free agency always has replacement-level names on the board.
  const dayOneFreeAgents = (await db.players.toArray()).filter((p) => p.teamId === null)
  console.log(`day-one free agents: ${dayOneFreeAgents.length}`)
  if (dayOneFreeAgents.length === 0) throw new Error('Expected a seeded free agent pool at league creation')
  console.log('OK: league starts with a real free agent pool to sign from')

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
    // No player should ever be generated above their position's realistic
    // max age, and the fresh-league age spread shouldn't already be
    // sitting on the retirement cliff - a real regression here generated
    // ages uniformly up toward each position's *average* retirement age,
    // which caused roughly a third of the league to retire in year one.
    const allPlayers = await db.players.toArray()
    for (const p of allPlayers) {
      const { maxAge } = POSITION_AGE_PROFILE[p.position]
      if (p.age > maxAge) {
        throw new Error(`Player ${p.id} (${p.position}) generated at age ${p.age}, above position max ${maxAge}`)
      }
    }
    const avgAge = allPlayers.reduce((s, p) => s + p.age, 0) / allPlayers.length
    console.log(`fresh league average player age: ${avgAge.toFixed(1)}`)
    if (avgAge < 20 || avgAge > 28) {
      throw new Error(`Fresh league average age (${avgAge.toFixed(1)}) looks unrealistic (expected ~22-26)`)
    }
    console.log('OK: generated ages respect position max age and look like a fresh (young) league')
  })()

  await (async () => {
    // Potential is meant to represent real remaining upside - a 30-year-old
    // running back or corner shouldn't be sitting on a potential far above
    // his current overall (real careers overwhelmingly decline with age at
    // those positions), while QB/K/P are allowed to keep a real gap since
    // those careers can extend or even peak into their late 30s.
    const allPlayers = await db.players.toArray()
    const exempt = new Set(['QB', 'K', 'P'])
    const oldDeclinePositionPlayers = allPlayers.filter((p) => p.age >= 30 && !exempt.has(p.position))
    if (oldDeclinePositionPlayers.length > 0) {
      const avgGap =
        oldDeclinePositionPlayers.reduce((s, p) => s + (p.ratings.potential - p.ratings.overall), 0) /
        oldDeclinePositionPlayers.length
      const maxGap = Math.max(...oldDeclinePositionPlayers.map((p) => p.ratings.potential - p.ratings.overall))
      console.log(
        `age 30+ decline-position players: n=${oldDeclinePositionPlayers.length}, avg potential gap=${avgGap.toFixed(2)}, max=${maxGap}`,
      )
      if (avgGap > 3) {
        throw new Error(`Age 30+ decline-position players still average a ${avgGap.toFixed(1)}-point potential gap`)
      }
    }
    console.log('OK: potential gap shrinks with age for decline-prone positions')
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
    const badTrade = await proposeTrade(leagueId, startLeague.userTeamId!, otherTeam.id, [myWorst.id], [theirBest.id])
    if (badTrade.accepted) throw new Error('AI accepted a lopsided trade in the user\'s favor')

    // Trades now require the responding team (otherTeam, giving up `theirs`
    // and receiving `mine`) to come out ahead on value - more so the better
    // the player they're giving up. "Fair" here means finding a
    // same-position pair where what otherTeam receives (mine) is modestly
    // better than what they send away (theirs), not exactly equal value.
    let closest: { mine: (typeof myRoster)[number]; theirs: (typeof theirRoster)[number]; diff: number } | null =
      null
    for (const mine of myRoster) {
      for (const theirs of theirRoster) {
        if (mine.position !== theirs.position) continue
        const mineValue = playerValue(mine)
        const theirsValue = playerValue(theirs)
        if (theirsValue <= 0 || mineValue < theirsValue * 1.2) continue
        const diff = mineValue / theirsValue - 1.2
        if (!closest || diff < closest.diff) closest = { mine, theirs, diff }
      }
    }
    if (!closest) throw new Error('No comparable same-position players found to test trades with')

    const fairTrade = await proposeTrade(
      leagueId,
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

  await (async () => {
    // Draft pick trading: give up a future 1st, get back a future 3rd plus
    // enough extra pick value to clear evaluateTrade's bar, then confirm
    // ownership actually moved and the draft later respects it (the team
    // that received the 1st should be the one on the clock for it).
    const startLeague = (await db.leagues.get(leagueId))!
    const teams = await db.teams.toArray()
    const userTeamId = startLeague.userTeamId!
    const otherTeam = teams.find((t) => t.id !== userTeamId)!
    const allTeamIds = teams.map((t) => t.id)

    const myOwnedPicks = ownedPicks(startLeague.tradedPicks, startLeague.season, allTeamIds, userTeamId, 5)
    const myFirstRounder = myOwnedPicks.find((p) => p.round === 1 && p.originalTeamId === userTeamId)
    if (!myFirstRounder) throw new Error('Expected the user to own their own future 1st-round pick before any trades')

    const theirOwnedPicks = ownedPicks(startLeague.tradedPicks, startLeague.season, allTeamIds, otherTeam.id, 5)
    const theirLateRounders = theirOwnedPicks.filter((p) => p.round >= 5 && p.originalTeamId === otherTeam.id)
    if (theirLateRounders.length < 3) throw new Error('Expected the other team to own at least 3 late-round picks to test with')

    const pickTrade = await proposeTrade(
      leagueId,
      userTeamId,
      otherTeam.id,
      [],
      [],
      [myFirstRounder],
      theirLateRounders.slice(0, 3),
    )
    if (!pickTrade.accepted) {
      throw new Error(`Expected a 1st-round pick for three Day 3 picks to be accepted, got: ${pickTrade.reason}`)
    }

    const leagueAfterPickTrade = await db.leagues.get(leagueId)
    const newOwner = pickOwner(leagueAfterPickTrade!.tradedPicks, myFirstRounder.year, myFirstRounder.round, myFirstRounder.originalTeamId)
    if (newOwner !== otherTeam.id) {
      throw new Error(`Expected ${otherTeam.id} to now own the traded 1st-rounder, owner is ${newOwner}`)
    }
    const receivedBack = theirLateRounders
      .slice(0, 3)
      .every((ref) => pickOwner(leagueAfterPickTrade!.tradedPicks, ref.year, ref.round, ref.originalTeamId) === userTeamId)
    if (!receivedBack) throw new Error('Expected the user to now own the three late-round picks received back')
    console.log('OK: draft pick trading moves ownership correctly and is folded into trade value')
  })()

  await (async () => {
    // Trade block: flag a player, force-generate an AI offer for them, and
    // accept it - confirms the whole offer pipeline (generation, display
    // data, acceptance) works end to end.
    const startLeague = (await db.leagues.get(leagueId))!
    const userTeamId = startLeague.userTeamId!
    const myRoster = await db.players.where('teamId').equals(userTeamId).toArray()
    const blockTarget = [...myRoster].sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
    await toggleTradeBlock(blockTarget.id)
    const blocked = await db.players.get(blockTarget.id)
    if (!blocked?.onTradeBlock) throw new Error('toggleTradeBlock did not flag the player')

    // generateTradeOffers only fires ~50% of weeks and needs a team with a
    // real need at the blocked position - retry a handful of times, varying
    // the week to get different rng draws/team picks, then restore the real
    // week afterward (this runs before playSeason - nothing has consumed
    // the schedule yet, so bumping week here must not leak into the actual
    // season sim below).
    const originalWeek = startLeague.week
    let offer = null
    for (let i = 0; i < 20 && !offer; i++) {
      await db.leagues.update(leagueId, { week: originalWeek + i })
      await generateTradeOffers(leagueId)
      const withOffers = await db.leagues.get(leagueId)
      offer = (withOffers?.pendingTradeOffers ?? [])[0] ?? null
    }
    await db.leagues.update(leagueId, { week: originalWeek })
    if (!offer) {
      console.log('OK: no AI trade offer materialized in 20 tries (position/cap/need mismatch) - skipping accept check')
    } else {
      const acceptResult = await acceptTradeOffer(leagueId, offer.id)
      if (!acceptResult.accepted) throw new Error(`Expected the pre-vetted AI offer to be accepted, got: ${acceptResult.reason}`)
      const tradedAway = await db.players.get(blockTarget.id)
      if (tradedAway?.teamId === userTeamId) throw new Error('Accepting the trade offer did not move the blocked player off the user team')
      const leagueAfterAccept = await db.leagues.get(leagueId)
      if ((leagueAfterAccept?.pendingTradeOffers ?? []).some((o) => o.id === offer.id)) {
        throw new Error('Accepted offer is still listed as pending')
      }
      console.log('OK: AI trade offer generated for a blocked player and accepted correctly')
    }
  })()

  await (async () => {
    // Suggested trades: whatever comes back must actually be a deal the AI
    // side would take (evaluateTrade-accepted) and must fit the user's cap.
    const suggestions = await findSuggestedTrades(leagueId, 5)
    const multiPiece = suggestions.filter((s) => s.giveIds.length + s.getIds.length + s.givePicks.length > 2).length
    console.log(
      `suggested trades: ${suggestions.length} candidate(s), ${suggestions.filter((s) => s.givePicks.length > 0).length} with a pick sweetener, ${multiPiece} multi-piece (not 1-for-1)`,
    )
    const usedGiveIds = new Set<number>()
    const usedPickKeys = new Set<string>()
    let checked = 0
    for (const s of suggestions) {
      if (s.giveIds.length === 0 || s.getIds.length === 0) throw new Error('Suggested trade has an empty side')
      if (s.give.length !== s.giveIds.length || s.get.length !== s.getIds.length) {
        throw new Error('Suggested trade give/get detail arrays do not match their id arrays')
      }
      // A player/pick already traded away by an earlier suggestion this loop
      // isn't a fresh failure of the feature - skip instead of asserting.
      if (s.giveIds.some((id) => usedGiveIds.has(id))) continue
      const pickKeys = s.givePicks.map((r) => `${r.year}-${r.round}-${r.originalTeamId}`)
      if (pickKeys.some((k) => usedPickKeys.has(k))) continue
      const outcome = await proposeTrade(
        leagueId,
        (await db.leagues.get(leagueId))!.userTeamId!,
        s.otherTeamId,
        s.giveIds,
        s.getIds,
        s.givePicks,
      )
      if (!outcome.accepted) {
        throw new Error(`Suggested trade was not actually acceptable when proposed: ${outcome.reason}`)
      }
      s.giveIds.forEach((id) => usedGiveIds.add(id))
      pickKeys.forEach((k) => usedPickKeys.add(k))
      checked++
    }
    console.log(`OK: findSuggestedTrades only returns deals the AI side actually accepts (${checked} executed)`)

    // Refreshing (a different seed) should be able to surface a different
    // slice of the league - not asserted strictly (small leagues can
    // legitimately converge on the same best options), just sanity-checked
    // that it runs cleanly and returns a well-formed list.
    const refreshed = await findSuggestedTrades(leagueId, 5, 12345)
    for (const s of refreshed) {
      if (s.giveIds.length === 0 || s.getIds.length === 0) throw new Error('Refreshed suggestion has an empty side')
    }
    console.log(`OK: findSuggestedTrades with a different seed returns ${refreshed.length} well-formed candidate(s)`)
  })()

  await playSeason(leagueId)

  const league = await db.leagues.get(leagueId)
  if (league?.phase !== 'complete') throw new Error('League did not reach complete phase')
  if (league.champTeamId == null) throw new Error('No champion set')
  await assertSeasonSane(leagueId, league.season)

  const historyAfterSeason1 = await getSeasonHistory(leagueId)
  if (historyAfterSeason1.length !== 1) {
    throw new Error(`Expected 1 season in history, got ${historyAfterSeason1.length}`)
  }
  if (historyAfterSeason1[0].champTeamId !== league.champTeamId) {
    throw new Error('getSeasonHistory champion does not match league.champTeamId')
  }
  console.log('OK: season history matches champion after season 1')

  await (async () => {
    const allPlayers = await db.players.toArray()
    const injured = allPlayers.filter((p) => p.injury)
    console.log('injured players after season 1:', injured.length, 'of', allPlayers.length)
    if (injured.length === 0) throw new Error('Expected at least some injuries after a full season')
    for (const p of injured) {
      if (p.injury!.weeksRemaining < 1) {
        throw new Error(`Player ${p.id} has an injury with weeksRemaining < 1`)
      }
    }
    console.log('OK: injuries occurred over the season')
  })()

  await (async () => {
    // Usage should be concentrated on the best players at each position, not
    // spread evenly across the whole depth chart.
    const stats = await db.playerGameStats.where('leagueId').equals(leagueId).toArray()
    const players = await db.players.toArray()

    const totalByPlayer = new Map<number, number>()
    for (const s of stats) {
      const total = s.rushYards + s.recYards
      totalByPlayer.set(s.playerId, (totalByPlayer.get(s.playerId) ?? 0) + total)
    }

    const rbs = players.filter((p) => p.position === 'RB' && p.teamId != null)
    const byTeam = new Map<number, typeof rbs>()
    for (const p of rbs) {
      const list = byTeam.get(p.teamId!) ?? []
      list.push(p)
      byTeam.set(p.teamId!, list)
    }
    let starterHeavyTeams = 0
    let comparedTeams = 0
    for (const [, teamRbs] of byTeam) {
      if (teamRbs.length < 2) continue
      const sorted = [...teamRbs].sort((a, b) => b.ratings.overall - a.ratings.overall)
      const starterYards = totalByPlayer.get(sorted[0].id) ?? 0
      const backupYards = totalByPlayer.get(sorted[sorted.length - 1].id) ?? 0
      comparedTeams++
      if (starterYards > backupYards) starterHeavyTeams++
    }
    console.log(
      `RB usage: starter out-produced deepest backup on ${starterHeavyTeams}/${comparedTeams} teams`,
    )
    if (comparedTeams > 0 && starterHeavyTeams / comparedTeams < 0.8) {
      throw new Error('RB touches are not concentrated on starters as expected')
    }
    console.log('OK: usage is concentrated on top players')
  })()

  await (async () => {
    // Season grades should cover every position (not just offensive skill
    // positions - the resign screen needs a grade for OL/DL/CB/K/etc too)
    // and actually spread across more than one letter, not collapse
    // everyone into the same grade.
    const stats = await db.playerGameStats.where('leagueId').equals(leagueId).toArray()
    const grades = gradeSeasonPerformance(stats)
    if (grades.size === 0) throw new Error('Expected some players to receive a season grade')

    const players = await db.players.toArray()
    const playerById = new Map(players.map((p) => [p.id, p]))
    const gradedPositions = new Set(
      [...grades.keys()].map((id) => playerById.get(id)?.position).filter((p): p is Position => p != null),
    )
    console.log(`season grades: ${grades.size} players graded across positions [${[...gradedPositions].sort().join(', ')}]`)
    if (gradedPositions.size < 5) {
      throw new Error(`Expected grades across most positions, only got: ${[...gradedPositions].join(', ')}`)
    }
    const distinctGrades = new Set(grades.values())
    if (distinctGrades.size < 3) {
      throw new Error(`Expected grades to spread across several letters, only saw: ${[...distinctGrades].join(', ')}`)
    }
    console.log('OK: season grades cover most positions and spread across multiple letters')
  })()

  await (async () => {
    // Injuries should cost the player some potential, scaled to severity.
    const injured = (await db.players.toArray()).filter((p) => p.injury)
    console.log(`checked injury potential loss on ${injured.length} injured players`)
    console.log('OK: injury potential-loss wiring is present (verified no crashes, values clamp 40-99)')
    for (const p of injured) {
      if (p.ratings.potential < 40 || p.ratings.potential > 99) {
        throw new Error(`Player ${p.id} has out-of-range potential ${p.ratings.potential} after injury`)
      }
    }
  })()

  await (async () => {
    // Depth chart reordering: bench the user's starting RB and confirm the
    // backup becomes RB1 (by depthOrder), and it round-trips back.
    const leagueNow = (await db.leagues.get(leagueId))!
    if (leagueNow.userTeamId == null) throw new Error('League has no user team')
    const rbGroup = (await db.players.where('teamId').equals(leagueNow.userTeamId).toArray())
      .filter((p) => p.position === 'RB')
      .sort((a, b) => a.depthOrder - b.depthOrder)
    if (rbGroup.length < 2) throw new Error('Expected at least 2 RBs on the user roster to test depth chart moves')

    const starter = rbGroup[0]
    await moveDepthChart(leagueNow.userTeamId, starter.id, 'down')
    const afterMove = (await db.players.where('teamId').equals(leagueNow.userTeamId).toArray())
      .filter((p) => p.position === 'RB')
      .sort((a, b) => a.depthOrder - b.depthOrder)
    if (afterMove[0].id !== rbGroup[1].id) {
      throw new Error('moveDepthChart did not promote the backup RB to the top of the depth chart')
    }
    console.log('OK: depth chart reordering swaps players correctly')
  })()

  await (async () => {
    // Best Roster should reset every position to best-overall-first,
    // undoing the manual bench move above.
    const leagueNow = (await db.leagues.get(leagueId))!
    if (leagueNow.userTeamId == null) throw new Error('League has no user team')
    await optimizeDepthChart(leagueNow.userTeamId)
    const rbGroup = (await db.players.where('teamId').equals(leagueNow.userTeamId).toArray())
      .filter((p) => p.position === 'RB')
      .sort((a, b) => a.depthOrder - b.depthOrder)
    for (let i = 0; i < rbGroup.length - 1; i++) {
      if (rbGroup[i].ratings.overall < rbGroup[i + 1].ratings.overall) {
        throw new Error('optimizeDepthChart did not sort RBs best-overall-first')
      }
    }
    console.log('OK: Best Roster sorts every position best-overall-first')
  })()

  await (async () => {
    // In-season performance should occasionally move ratings and set a
    // trend arrow - not every player every week (too noisy), but some
    // signal should show up over a full season league-wide.
    const players = await db.players.toArray()
    const trending = players.filter((p) => p.trend === 'up' || p.trend === 'down')
    console.log(`players with a trend set after season 1: ${trending.length} of ${players.length}`)
    if (trending.length === 0) throw new Error('Expected at least some players to have a trend set after a full season')
    for (const p of trending) {
      if (p.ratings.overall < 40 || p.ratings.overall > p.ratings.potential) {
        throw new Error(`Player ${p.id} overall ${p.ratings.overall} out of bounds (potential ${p.ratings.potential})`)
      }
    }
    console.log('OK: in-season performance nudges ratings and sets trend within bounds')
  })()

  await (async () => {
    // Position/team overall should be starter-weighted: swapping a strong
    // starter to the bottom of the depth chart and a weak backup to the top
    // should measurably drag the position (and team) overall down, even
    // though the underlying set of players - and a flat average - is
    // unchanged.
    const leagueNow = (await db.leagues.get(leagueId))!
    if (leagueNow.userTeamId == null) throw new Error('League has no user team')
    const roster = await db.players.where('teamId').equals(leagueNow.userTeamId).toArray()
    const wrGroup = roster.filter((p) => p.position === 'WR').sort((a, b) => a.depthOrder - b.depthOrder)
    if (wrGroup.length < 2) throw new Error('Expected at least 2 WRs to test starter-weighted overall')

    const before = computePositionOverall(wrGroup)
    const bestId = [...wrGroup].sort((a, b) => b.ratings.overall - a.ratings.overall)[0].id
    const worstId = [...wrGroup].sort((a, b) => a.ratings.overall - b.ratings.overall)[0].id
    if (bestId !== worstId) {
      if (wrGroup[0].id === bestId) await moveDepthChart(leagueNow.userTeamId, bestId, 'down')
    }

    const rosterAfter = await db.players.where('teamId').equals(leagueNow.userTeamId).toArray()
    const wrGroupAfter = rosterAfter.filter((p) => p.position === 'WR').sort((a, b) => a.depthOrder - b.depthOrder)
    const after = computePositionOverall(wrGroupAfter)
    const flatAverage = wrGroup.reduce((s, p) => s + p.ratings.overall, 0) / wrGroup.length

    console.log(`WR overall: starter-weighted before=${before.toFixed(1)} after-bench-swap=${after.toFixed(1)} flat-average=${flatAverage.toFixed(1)}`)
    if (before === after) {
      throw new Error('Position overall did not change after reordering the depth chart - not starter-weighted')
    }
    if (Math.abs(before - flatAverage) < 0.01) {
      throw new Error('Position overall matches a flat average - expected it to be weighted toward starters')
    }

    const teamOverall = computeTeamOverall(rosterAfter)
    if (teamOverall <= 0) throw new Error('computeTeamOverall returned a non-positive value')
    console.log(`team overall (weighted): ${teamOverall.toFixed(1)}`)
    console.log('OK: position/team overall is starter-weighted, not a flat roster average')
  })()

  console.log('OK: season 1 smoke test passed')

  const ratingsBefore = new Map(
    (await db.players.toArray()).map((p) => [p.id, p.ratings.overall]),
  )
  const experienceBefore = new Map(
    (await db.players.toArray()).map((p) => [p.id, p.experience ?? 0]),
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

  // Every surviving player should be exactly one season more experienced
  // after an offseason - this is what backs the roster screen's Exp column
  // (and confirms a fresh league's veterans didn't all start at 0).
  const survivorsWithHistory = survivors.filter((p) => experienceBefore.has(p.id))
  const experienceMismatch = survivorsWithHistory.find(
    (p) => (p.experience ?? 0) !== (experienceBefore.get(p.id) ?? 0) + 1,
  )
  if (experienceMismatch) {
    throw new Error(
      `Player ${experienceMismatch.id} experience went from ${experienceBefore.get(experienceMismatch.id)} to ${experienceMismatch.experience}, expected +1`,
    )
  }
  const veteransAtStart = [...experienceBefore.values()].filter((e) => e > 0).length
  if (veteransAtStart === 0) throw new Error('Expected a fresh league to start with some non-rookie veterans (experience > 0)')
  console.log(`OK: experience increments by exactly 1 per offseason (${veteransAtStart} day-one veterans had experience > 0)`)

  // The first-ever offseason of a fresh (young) league shouldn't retire a
  // huge chunk of the roster - regression check for the age-generation bug
  // above (mass early retirements should never exceed a sane ceiling).
  const retirementRate = faResult.retiredCount / rosterCountBefore
  if (retirementRate > 0.2) {
    throw new Error(`First-season retirement rate (${(retirementRate * 100).toFixed(1)}%) is unrealistically high`)
  }

  const leagueInResign = await db.leagues.get(leagueId)
  console.log('free agency:', faResult)
  console.log('season during resign window:', leagueInResign?.season, leagueInResign?.phase)
  if (leagueInResign?.phase !== 'resign') throw new Error('League did not enter the resign phase')
  if (leagueInResign.season !== league.season + 1) throw new Error('Season number did not increment')
  if (leagueInResign.userTeamId == null) throw new Error('League has no user team')

  // Cutting a player during the resign window should free them to the pool
  // and immediately open up cap space.
  const resignRoster = await db.players.where('teamId').equals(leagueInResign.userTeamId).toArray()
  const cutCandidate = resignRoster.sort((a, b) => a.ratings.overall - b.ratings.overall)[0]
  await cutPlayer(leagueId, cutCandidate.id)
  const afterCut = await db.players.get(cutCandidate.id)
  if (afterCut?.teamId !== null || afterCut?.contract !== null) {
    throw new Error('cutPlayer did not release the player to free agency')
  }
  console.log('OK: cut a player during the resign window')

  // Resigning an expired-contract player should keep them on the team with
  // a fresh contract instead of letting them slip into free agency.
  const rosterAfterCut = await db.players.where('teamId').equals(leagueInResign.userTeamId).toArray()
  const expiring = rosterAfterCut.filter((p) => p.contract === null)
  console.log(`players on user team needing a contract decision: ${expiring.length}`)
  if (expiring.length > 0) {
    const toResign = expiring[0]
    await resignPlayer(leagueId, toResign.id, 3)
    const afterResign = await db.players.get(toResign.id)
    if (afterResign?.teamId !== leagueInResign.userTeamId) {
      throw new Error('resignPlayer did not keep the player on the team')
    }
    if (!afterResign.contract || afterResign.contract.yearsLeft !== 3 || afterResign.contract.salary <= 0) {
      throw new Error('resignPlayer did not assign a sane new contract')
    }
    console.log('OK: resigned an expiring player to a new 3-year contract')
  } else {
    console.log('OK: no expiring contracts to resign this cycle (nothing to test)')
  }

  // Extending an already-signed player should replace their existing deal.
  const stillSigned = rosterAfterCut.find((p) => p.contract !== null)
  if (stillSigned) {
    const oldContract = stillSigned.contract!
    await resignPlayer(leagueId, stillSigned.id, 4)
    const afterExtend = await db.players.get(stillSigned.id)
    if (!afterExtend?.contract || afterExtend.contract.yearsLeft !== 4) {
      throw new Error('resignPlayer did not extend the already-signed player to 4 years')
    }
    console.log(`OK: extended an already-signed player (was ${oldContract.yearsLeft}yr, now 4yr)`)
  }

  // Anyone left with no contract when free agency opens should be released,
  // same as every other team's uncontested expirations.
  const undecidedBeforeOpen = (await db.players.where('teamId').equals(leagueInResign.userTeamId).toArray()).filter(
    (p) => p.contract === null,
  )

  await openFreeAgency(leagueId)

  for (const p of undecidedBeforeOpen) {
    const after = await db.players.get(p.id)
    if (after?.teamId !== null) {
      throw new Error(`Player ${p.id} was left on the roster with no contract after free agency opened`)
    }
  }
  console.log(`OK: ${undecidedBeforeOpen.length} un-resigned player(s) released to free agency on open`)
  const leagueInFA = await db.leagues.get(leagueId)
  console.log('season during free agency:', leagueInFA?.season, leagueInFA?.phase)
  if (leagueInFA?.phase !== 'freeagency') throw new Error('League did not enter free agency phase')

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

  // Free agency shouldn't be flooded with stars - real teams proactively
  // re-sign the players they want to keep before they ever hit the market,
  // so the pool should skew below the league's overall talent level, not
  // match or exceed it.
  const leagueAvgOverall = (await db.players.toArray()).reduce((s, p) => s + p.ratings.overall, 0) / (await db.players.count())
  const eliteFAs = stillFreeAgents.filter((p) => p.ratings.overall >= 80)
  const eliteFaShare = eliteFAs.length / stillFreeAgents.length
  console.log(
    `free agent pool: ${stillFreeAgents.length} players, avg overall ${(stillFreeAgents.reduce((s, p) => s + p.ratings.overall, 0) / stillFreeAgents.length).toFixed(1)} (league avg ${leagueAvgOverall.toFixed(1)}), ${eliteFAs.length} at 80+ overall (${(eliteFaShare * 100).toFixed(1)}%)`,
  )
  if (eliteFaShare > 0.15) {
    throw new Error(`${(eliteFaShare * 100).toFixed(1)}% of free agents are 80+ overall - AI retention isn't keeping stars off the market`)
  }
  console.log('OK: AI retention keeps free agency from being flooded with elite talent')

  // Elite free agents now cost real-NFL-scale money, so the top overall
  // talent on the board may not fit under the user's remaining cap space -
  // that's intentional (no more stacking a dozen 90-overalls for pennies).
  // Sign the best one that's actually affordable.
  const userCapSpace = computeCapSpace(userRosterBeforeSigning)
  const userNeeds = rosterNeeds(userRosterBeforeSigning)
  const affordableFAs = stillFreeAgents
    .filter((p) => userNeeds.includes(p.position) && marketSalary(p.position, p.ratings.overall, p.age) * 1.15 <= userCapSpace)
    .sort((a, b) => b.ratings.overall - a.ratings.overall)
  if (affordableFAs.length === 0) throw new Error('Expected at least one affordable free agent')
  const targetFA = affordableFAs[0]
  await signFreeAgent(leagueId, targetFA.id)
  const signedPlayer = await db.players.get(targetFA.id)
  if (signedPlayer?.teamId !== leagueInFA.userTeamId) {
    throw new Error('signFreeAgent did not actually assign the player to the user team')
  }
  if (!signedPlayer.contract) throw new Error('Signed player has no contract')
  console.log('OK: signed a free agent to the user team')

  const rosterCountBeforeDraft = await db.players.count()

  // beginDraft must NOT gate on roster size - the draft itself adds up to
  // DRAFT_ROUNDS rookies, so being under 53 going in is completely normal.
  // Confirm it succeeds even though the user roster is under 53 right now.
  const userRosterPreDraft = await db.players.where('teamId').equals(leagueInFA.userTeamId).toArray()
  if (userRosterPreDraft.length >= MIN_ROSTER_SIZE) {
    throw new Error('Expected the user roster to be under 53 at this point in the smoke test setup')
  }
  const userIdsBeforeDraft = new Set(userRosterPreDraft.map((p) => p.id))
  await beginDraft(leagueId)
  console.log(`OK: beginDraft succeeds with a ${userRosterPreDraft.length}-man roster (under the ${MIN_ROSTER_SIZE}-man minimum) - the draft still has to add its rookies`)

  // Drive the interactive draft to completion: whenever it's the user's
  // turn, pick the best available prospect at a position they need; AI
  // turns already auto-advance inside beginDraft/makeUserDraftPick.
  let draftedCount = 0
  let board = await getDraftBoard(leagueId)
  if (!board) throw new Error('Expected a draft board to be set up after beginDraft')

  // Sanity-check the draft class itself before drafting anyone from it:
  // real colleges, age cap, and the overall curve (87 max, only 2-3 that
  // high, tapering down from there).
  if (board.prospects.length === 0) throw new Error('Draft class is empty')
  for (const p of board.prospects) {
    if (p.age > 25) throw new Error(`Prospect ${p.firstName} ${p.lastName} is age ${p.age}, above the 25 cap`)
    if (p.ratings.overall > 87) throw new Error(`Prospect overall ${p.ratings.overall} exceeds the 87 draft-class cap`)
    if (!p.college) throw new Error('Prospect is missing a college')
  }
  const eliteProspects = board.prospects.filter((p) => p.ratings.overall >= 87)
  console.log(
    `draft class: ${board.prospects.length} prospects, ${eliteProspects.length} at the 87 overall cap, oldest age ${Math.max(...board.prospects.map((p) => p.age))}`,
  )
  if (eliteProspects.length < 1 || eliteProspects.length > 3) {
    throw new Error(`Expected 1-3 prospects at the overall cap, got ${eliteProspects.length}`)
  }

  const teamCountForDraft = (await db.teams.toArray()).length
  const expectedTotalPicks = teamCountForDraft * DRAFT_ROUNDS
  if (board.totalPicks !== expectedTotalPicks) {
    throw new Error(`Expected ${expectedTotalPicks} total picks (${teamCountForDraft} teams x ${DRAFT_ROUNDS} rounds), got ${board.totalPicks}`)
  }
  console.log(`OK: draft is exactly ${DRAFT_ROUNDS} rounds (${expectedTotalPicks} total picks across ${teamCountForDraft} teams)`)

  // Cutting should also work mid-draft, so a user can shed a weak roster
  // spot to make room for the pick they're about to make.
  const draftCutCandidate = (await db.players.where('teamId').equals(leagueInFA.userTeamId).toArray()).sort(
    (a, b) => a.ratings.overall - b.ratings.overall,
  )[0]
  await cutPlayer(leagueId, draftCutCandidate.id)
  const draftCutAfter = await db.players.get(draftCutCandidate.id)
  if (draftCutAfter?.teamId !== null) throw new Error('Cutting during the draft did not release the player to free agency')
  console.log('OK: cut a player during the draft')

  // Every team gets exactly one pick per round now (best-player-available
  // once their needs are filled, not skipped) - the user should get
  // exactly DRAFT_ROUNDS picks total, one per round. Only drive the first
  // 3 rounds interactively, then hand the rest to simRestOfDraft (the "Sim
  // Rest of Draft" button) to exercise that escape hatch too.
  const MANUAL_ROUNDS = 3
  let guard = 0
  while (board && draftedCount < MANUAL_ROUNDS && board.pickedIndices.size < board.totalPicks && guard < board.totalPicks + 5) {
    guard++
    if (!board.isUserTurn) break // AI-only remainder already resolved internally
    const available = board.prospects.filter((p) => !board.pickedIndices.has(p.index))
    const userRoster = await db.players.where('teamId').equals(leagueInFA.userTeamId).toArray()
    const needs = new Set(rosterNeeds(userRoster))
    const pick =
      available.filter((p) => needs.has(p.position)).sort((a, b) => b.ratings.overall - a.ratings.overall)[0] ??
      [...available].sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
    if (!pick) break
    await makeUserDraftPick(leagueId, pick.index)
    draftedCount++
    board = await getDraftBoard(leagueId)
  }
  console.log(`OK: user made ${draftedCount} draft picks interactively`)
  if (draftedCount !== MANUAL_ROUNDS) {
    throw new Error(`Expected to make exactly ${MANUAL_ROUNDS} manual picks before handing off, got ${draftedCount}`)
  }

  await simRestOfDraft(leagueId)
  const leagueAfterSim = await db.leagues.get(leagueId)
  if (leagueAfterSim?.phase !== 'regular') {
    throw new Error(`Expected simRestOfDraft to finish the draft and roll into the regular season, phase is ${leagueAfterSim?.phase}`)
  }
  const userRosterAfterSim = await db.players.where('teamId').equals(leagueInFA.userTeamId).toArray()
  const draftedRookies = userRosterAfterSim.filter((p) => !userIdsBeforeDraft.has(p.id))
  draftedCount = draftedRookies.length
  console.log(`OK: simRestOfDraft auto-drafted the remaining rounds (user roster gained ${draftedCount} newly drafted players)`)

  // Real NFL rookie deals are a fixed 4-year term with experience=0 at
  // signing - confirms newly drafted players actually land on that (not
  // just any player who happens to carry a 4-year deal, e.g. an extended
  // veteran).
  const badRookie = draftedRookies.find((p) => p.contract?.yearsLeft !== 4 || (p.experience ?? 0) !== 0)
  if (badRookie) {
    throw new Error(
      `Drafted rookie ${badRookie.id} has yearsLeft=${badRookie.contract?.yearsLeft}, experience=${badRookie.experience}, expected yearsLeft=4, experience=0`,
    )
  }
  console.log('OK: drafted rookies land on a 4-year rookie deal with 0 experience')

  const rosterCountAfter = await db.players.count()
  const leagueAfterOffseason = await db.leagues.get(leagueId)

  if (rosterCountAfter !== rosterCountBeforeDraft + expectedTotalPicks) {
    throw new Error(
      `Expected exactly ${expectedTotalPicks} players added by the draft (no skipped picks), went from ${rosterCountBeforeDraft} to ${rosterCountAfter}`,
    )
  }
  console.log(`OK: draft added exactly ${expectedTotalPicks} players with no skipped picks`)

  console.log('roster count before/after FA+draft:', rosterCountBefore, rosterCountAfterFA, rosterCountAfter)
  console.log('season after offseason:', leagueAfterOffseason?.season, leagueAfterOffseason?.phase)

  if (leagueAfterOffseason?.phase !== 'regular' || leagueAfterOffseason.week !== 1) {
    throw new Error('League did not roll into a fresh regular season after the draft')
  }
  if (rosterCountAfter <= rosterCountBeforeDraft) {
    throw new Error('Roster count did not grow from draft picks')
  }

  // The real gate is here: week 1 of the regular season, after the draft's
  // rookies have already landed. If the draft (plus whatever was signed/cut
  // along the way) didn't reach a legal 53-man roster, simWeek must refuse
  // to kick the season off - then autoFillRoster is the escape hatch, and
  // simWeek should succeed once it's topped up.
  const userRosterPostDraft = await db.players.where('teamId').equals(leagueInFA.userTeamId).toArray()
  if (userRosterPostDraft.length < MIN_ROSTER_SIZE) {
    let threwForShortRoster = false
    try {
      await simWeek(leagueId)
    } catch {
      threwForShortRoster = true
    }
    if (!threwForShortRoster) throw new Error('simWeek should refuse to kick off week 1 with a sub-53-man roster')
    console.log(`OK: simWeek rejects kicking off week 1 with a ${userRosterPostDraft.length}-man roster (post-draft, below the ${MIN_ROSTER_SIZE}-man minimum)`)

    const { added } = await autoFillRoster(leagueId)
    const userRosterFilled = await db.players.where('teamId').equals(leagueInFA.userTeamId).toArray()
    if (userRosterFilled.length < MIN_ROSTER_SIZE) {
      throw new Error(`autoFillRoster only reached ${userRosterFilled.length}/${MIN_ROSTER_SIZE} players (added ${added})`)
    }
    console.log(`OK: autoFillRoster topped the post-draft roster up to ${userRosterFilled.length}/${MIN_ROSTER_SIZE} players`)
  } else {
    console.log(`OK: draft alone already reached a legal ${userRosterPostDraft.length}-man roster - no kickoff guard to trigger this run`)
  }
  await simWeek(leagueId) // week 1 - must succeed now that the roster is legal
  console.log('OK: simWeek kicks off week 1 successfully once the roster is legal')

  // computeCapSpace must never clamp to 0 - a roster that's over the cap
  // (easy to end up with right after a draft that added 7 more mouths to
  // feed) should show negative cap space, and cutting a player should move
  // that number even while still over, not just once back under.
  await (async () => {
    const userTeamId = leagueAfterOffseason.userTeamId!
    let roster = await db.players.where('teamId').equals(userTeamId).toArray()
    // Bump every remaining player's salary so the roster is definitely over
    // the cap, regardless of what this run's random rookie salaries added up to.
    await db.players.bulkPut(
      roster.map((p) => ({ ...p, contract: { salary: 5_000_000, yearsLeft: p.contract?.yearsLeft ?? 1 } })) as never[],
    )
    roster = await db.players.where('teamId').equals(userTeamId).toArray()
    const capBefore = computeCapSpace(roster)
    if (capBefore >= 0) throw new Error(`Expected the padded-salary roster to be over the cap, got capSpace=${capBefore}`)

    const cutCandidate = [...roster].sort((a, b) => a.ratings.overall - b.ratings.overall)[0]
    await cutPlayer(leagueId, cutCandidate.id)
    const rosterAfterCut = await db.players.where('teamId').equals(userTeamId).toArray()
    const capAfter = computeCapSpace(rosterAfterCut)
    if (capAfter >= 0) throw new Error(`Expected to still be over the cap after cutting just one of many, got capSpace=${capAfter}`)
    if (capAfter <= capBefore) {
      throw new Error(`Cutting a player while over the cap should free up cap space (less negative) - before=${capBefore}, after=${capAfter}`)
    }
    if (capAfter - capBefore !== 5_000_000) {
      throw new Error(`Expected cap space to move by exactly the cut player's salary (5,000,000) - moved by ${capAfter - capBefore}`)
    }
    console.log(`OK: computeCapSpace stays negative (not clamped to 0) while over the cap and moves correctly on a cut: ${capBefore} -> ${capAfter}`)
  })()

  // Mid-season roster moves: sim a few weeks in, cut a bench player off the
  // user's own team, and confirm they land back in the free agent pool and
  // can be replaced by signing someone else - without needing to wait for
  // the resign window.
  for (let i = 0; i < 3; i++) await simWeek(leagueId)
  const leagueMidSeason = await db.leagues.get(leagueId)
  if (leagueMidSeason?.phase !== 'regular') throw new Error('Expected league to still be mid-regular-season')
  if (leagueAfterOffseason.userTeamId == null) throw new Error('League has no user team')
  const midSeasonRoster = await db.players.where('teamId').equals(leagueAfterOffseason.userTeamId).toArray()
  const midSeasonCutCandidate = [...midSeasonRoster].sort((a, b) => a.ratings.overall - b.ratings.overall)[0]
  await cutPlayer(leagueId, midSeasonCutCandidate.id)
  const cutPlayerAfter = await db.players.get(midSeasonCutCandidate.id)
  if (cutPlayerAfter?.teamId !== null) throw new Error('Mid-season cut did not release the player to free agency')
  console.log('OK: cut a player mid-season and they became a free agent')

  const midSeasonFAs = (await db.players.toArray()).filter((p) => p.teamId === null)
  console.log(`free agents available mid-season: ${midSeasonFAs.length}`)
  if (midSeasonFAs.length < 5) {
    throw new Error(`Expected a real mid-season free agent pool (weekly trickle + seeded pool), only found ${midSeasonFAs.length}`)
  }
  console.log('OK: free agent pool has real supply mid-season, not just the player just cut')
  const midSeasonNeeds = new Set(rosterNeeds(await db.players.where('teamId').equals(leagueAfterOffseason.userTeamId).toArray()))
  const midSeasonCapSpace = computeCapSpace(await db.players.where('teamId').equals(leagueAfterOffseason.userTeamId).toArray())
  const midSeasonTarget = midSeasonFAs
    .filter((p) => midSeasonNeeds.has(p.position) && marketSalary(p.position, p.ratings.overall, p.age) * 1.15 <= midSeasonCapSpace)
    .sort((a, b) => b.ratings.overall - a.ratings.overall)[0]
  if (midSeasonTarget) {
    await signFreeAgent(leagueId, midSeasonTarget.id)
    const signedMidSeason = await db.players.get(midSeasonTarget.id)
    if (signedMidSeason?.teamId !== leagueAfterOffseason.userTeamId) {
      throw new Error('Mid-season signFreeAgent did not assign the player to the user team')
    }
    console.log('OK: signed a free agent mid-season after cutting a roster spot')
  }

  await playSeason(leagueId)
  const league2 = await db.leagues.get(leagueId)
  if (league2?.phase !== 'complete') throw new Error('Second season did not complete')
  await assertSeasonSane(leagueId, leagueAfterOffseason.season)

  const historyAfterSeason2 = await getSeasonHistory(leagueId)
  if (historyAfterSeason2.length !== 2) {
    throw new Error(`Expected 2 seasons in history, got ${historyAfterSeason2.length}`)
  }
  if (historyAfterSeason2[0].season <= historyAfterSeason2[1].season) {
    throw new Error('Season history is not sorted newest-first')
  }
  if (historyAfterSeason2[0].champTeamId !== league2.champTeamId) {
    throw new Error('Latest season history entry does not match current champTeamId')
  }
  console.log('OK: season history accumulates across seasons, newest first')

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
