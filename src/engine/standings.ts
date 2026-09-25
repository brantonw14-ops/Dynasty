import type { GameResult, Team } from '../types'

export interface StandingsRow {
  teamId: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
  pointsAgainst: number
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

  return [...rows.values()].sort((a, b) => {
    const winPct = (r: StandingsRow) => (r.wins + r.ties * 0.5) / Math.max(1, r.wins + r.losses + r.ties)
    const pctDiff = winPct(b) - winPct(a)
    if (pctDiff !== 0) return pctDiff
    return b.pointsFor - b.pointsAgainst - (a.pointsFor - a.pointsAgainst)
  })
}
