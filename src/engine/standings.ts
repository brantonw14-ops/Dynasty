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
    if (!home || !away) continue

    home.pointsFor += g.homeScore
    home.pointsAgainst += g.awayScore
    away.pointsFor += g.awayScore
    away.pointsAgainst += g.homeScore

    if (g.homeScore > g.awayScore) {
      home.wins++
      away.losses++
    } else if (g.awayScore > g.homeScore) {
      away.wins++
      home.losses++
    } else {
      home.ties++
      away.ties++
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
