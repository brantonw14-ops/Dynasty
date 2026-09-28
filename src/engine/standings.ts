import type { Conference, Division, GameResult, Team } from '../types'

export interface StandingsRow {
  teamId: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
  pointsAgainst: number
}

function winPct(r: StandingsRow) {
  return (r.wins + r.ties * 0.5) / Math.max(1, r.wins + r.losses + r.ties)
}

function compareRows(a: StandingsRow, b: StandingsRow) {
  const pctDiff = winPct(b) - winPct(a)
  if (pctDiff !== 0) return pctDiff
  return b.pointsFor - b.pointsAgainst - (a.pointsFor - a.pointsAgainst)
}

export function computeStandings(teams: Team[], games: GameResult[]): StandingsRow[] {
  const rows = new Map<number, StandingsRow>()
  for (const t of teams) {
    rows.set(t.id, { teamId: t.id, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 })
  }

  for (const g of games) {
    const home = rows.get(g.homeTeamId)
    const away = rows.get(g.awayTeamId)
    if (!home && !away) continue

    // A team's record counts every game it played, regardless of whether its
    // opponent is also in `teams` - callers often pass a subset (one
    // division, one conference) and most of a team's games are against
    // teams outside that subset.
    if (home) {
      home.pointsFor += g.homeScore
      home.pointsAgainst += g.awayScore
    }
    if (away) {
      away.pointsFor += g.awayScore
      away.pointsAgainst += g.homeScore
    }

    if (g.homeScore > g.awayScore) {
      if (home) home.wins++
      if (away) away.losses++
    } else if (g.awayScore > g.homeScore) {
      if (away) away.wins++
      if (home) home.losses++
    } else {
      if (home) home.ties++
      if (away) away.ties++
    }
  }

  return [...rows.values()].sort(compareRows)
}

export interface PlayoffSeed extends StandingsRow {
  seed: number
  divisionWinner: boolean
}

/**
 * Real NFL-style seeding: the 4 division winners take seeds 1-4 (ranked by
 * record), and the next 3 best remaining teams in the conference take
 * seeds 5-7 (wild cards). No head-to-head/common-game tiebreakers yet -
 * ties break on point differential only.
 */
export function computeConferenceSeeds(
  teams: Team[],
  games: GameResult[],
  conference: Conference,
): PlayoffSeed[] {
  const confTeams = teams.filter((t) => t.conference === conference)
  const standings = computeStandings(confTeams, games)
  const rowByTeam = new Map(standings.map((r) => [r.teamId, r]))

  const divisions: Division[] = ['East', 'North', 'South', 'West']
  const divisionWinners: StandingsRow[] = []
  for (const division of divisions) {
    const divTeamIds = new Set(confTeams.filter((t) => t.division === division).map((t) => t.id))
    const best = standings.find((r) => divTeamIds.has(r.teamId))
    if (best) divisionWinners.push(best)
  }
  divisionWinners.sort(compareRows)

  const winnerIds = new Set(divisionWinners.map((r) => r.teamId))
  const wildCards = standings.filter((r) => !winnerIds.has(r.teamId)).slice(0, 3)

  const seeded = [...divisionWinners, ...wildCards]
  return seeded.map((row, i) => ({
    ...rowByTeam.get(row.teamId)!,
    seed: i + 1,
    divisionWinner: winnerIds.has(row.teamId),
  }))
}

export interface ClinchStatus {
  clinchedPlayoffs: boolean
  clinchedBye: boolean
  eliminated: boolean
}

/**
 * Mathematical clinch/elimination check for one team, based only on the
 * current conference standings and how many regular-season games remain -
 * no simulation, no guessing at other teams' schedules. A team has clinched
 * a playoff spot once its worst-case final record (losing out) still beats
 * every currently-out team's best-case final record (winning out) by
 * enough that not enough of them can pass it for the final wild-card spot.
 * A bye is the same check against 2nd place instead of 8th. Elimination is
 * the mirror image: even winning out isn't enough to catch the current
 * cutoff team's current pace.
 */
export function computeClinchStatus(
  teams: Team[],
  regularGames: GameResult[],
  regularSeasonWeeks: number,
  teamId: number,
): ClinchStatus | null {
  const team = teams.find((t) => t.id === teamId)
  if (!team) return null

  const seeds = computeConferenceSeeds(teams, regularGames, team.conference)
  const mySeed = seeds.find((s) => s.teamId === teamId)
  if (!mySeed) return null

  // computeConferenceSeeds only returns the seeded top 7 - the "who could
  // still catch me" comparison needs every other team in the conference,
  // otherwise there's nothing to compare against and a team looks clinched
  // the moment it's in the top 7, even in week 1.
  const confTeams = teams.filter((t) => t.conference === team.conference)
  const allConfStandings = computeStandings(confTeams, regularGames)
  const seededIds = new Set(seeds.map((s) => s.teamId))
  const outStandings = allConfStandings.filter((r) => !seededIds.has(r.teamId))

  const gamesPlayed = (id: number) => regularGames.filter((g) => g.homeTeamId === id || g.awayTeamId === id).length
  const remaining = (id: number) => Math.max(0, regularSeasonWeeks - gamesPlayed(id))
  const bestCaseWins = (s: StandingsRow) => s.wins + remaining(s.teamId)
  const worstCaseWins = (s: StandingsRow) => s.wins

  const inField = seeds.slice(0, 7)
  const outField = outStandings
  const myWorstCase = worstCaseWins(mySeed)
  const myBestCase = bestCaseWins(mySeed)

  const clinchedPlayoffs = mySeed.seed <= 7 && outField.every((s) => myWorstCase > bestCaseWins(s))
  const clinchedBye =
    mySeed.seed === 1 && [...seeds.slice(1), ...outField].every((s) => myWorstCase > bestCaseWins(s))
  const cutoffTeam = inField[6]
  const eliminated = mySeed.seed > 7 && cutoffTeam != null && myBestCase < worstCaseWins(cutoffTeam)

  return { clinchedPlayoffs, clinchedBye, eliminated }
}
