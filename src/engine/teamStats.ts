import type { GameResult, PlayerGameStats } from '../types'

export interface TeamSeasonStats {
  teamId: number
  gamesPlayed: number
  offYards: number
  defYardsAllowed: number
  pointsFor: number
  pointsAgainst: number
  takeaways: number
  giveaways: number
  turnoverMargin: number
}

/**
 * Team-level season totals derived from the same per-player box scores
 * everything else already records - no separate team-stat table needed.
 * Offensive yards is passYards + rushYards only (never + recYards, which
 * would double-count the same yardage from the receiver's side of the same
 * completed pass). "Yards allowed" for a team is just its opponent's
 * offensive yards that game - simpler and more complete than trying to sum
 * the yardsAllowed field on individual defenders, which only ever covers a
 * share of passing yards allowed (see gameSim.ts), never rushing.
 * Turnover margin is takeaways (defInterceptions) minus giveaways
 * (interceptions thrown) - the only turnover type this game models, there's
 * no fumble tracking.
 */
export function computeTeamStats(
  teamIds: number[],
  games: GameResult[],
  playerStats: PlayerGameStats[],
): TeamSeasonStats[] {
  const statsByGame = new Map<number, PlayerGameStats[]>()
  for (const s of playerStats) {
    const list = statsByGame.get(s.gameId) ?? []
    list.push(s)
    statsByGame.set(s.gameId, list)
  }

  const result = new Map<number, TeamSeasonStats>(
    teamIds.map((id) => [
      id,
      { teamId: id, gamesPlayed: 0, offYards: 0, defYardsAllowed: 0, pointsFor: 0, pointsAgainst: 0, takeaways: 0, giveaways: 0, turnoverMargin: 0 },
    ]),
  )

  const offenseYards = (rows: PlayerGameStats[]) => rows.reduce((sum, r) => sum + r.passYards + r.rushYards, 0)
  const takeaways = (rows: PlayerGameStats[]) => rows.reduce((sum, r) => sum + r.defInterceptions, 0)
  const giveaways = (rows: PlayerGameStats[]) => rows.reduce((sum, r) => sum + r.interceptions, 0)

  for (const g of games) {
    const rowsInGame = statsByGame.get(g.id) ?? []
    const homeRows = rowsInGame.filter((r) => r.teamId === g.homeTeamId)
    const awayRows = rowsInGame.filter((r) => r.teamId === g.awayTeamId)
    const homeOff = offenseYards(homeRows)
    const awayOff = offenseYards(awayRows)

    const home = result.get(g.homeTeamId)
    if (home) {
      home.gamesPlayed += 1
      home.offYards += homeOff
      home.defYardsAllowed += awayOff
      home.pointsFor += g.homeScore
      home.pointsAgainst += g.awayScore
      home.takeaways += takeaways(homeRows)
      home.giveaways += giveaways(homeRows)
    }

    const away = result.get(g.awayTeamId)
    if (away) {
      away.gamesPlayed += 1
      away.offYards += awayOff
      away.defYardsAllowed += homeOff
      away.pointsFor += g.awayScore
      away.pointsAgainst += g.homeScore
      away.takeaways += takeaways(awayRows)
      away.giveaways += giveaways(awayRows)
    }
  }

  for (const t of result.values()) t.turnoverMargin = t.takeaways - t.giveaways
  return [...result.values()]
}
