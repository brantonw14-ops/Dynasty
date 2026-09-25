import type { Player, Position, Team } from '../types'
import { generatePlayer, rosterNeeds } from './players'
import { randInt, type Rng } from './rng'
import { marketSalary } from './salary'

export interface DraftPick {
  teamId: number
  player: Omit<Player, 'id'>
}

/**
 * Fills every team's roster back up to full strength via a worst-record-picks-first
 * draft. Draft order is provided by the caller (typically reverse standings).
 * Rookies get a below-market entry-level contract.
 */
export function runDraft(
  rng: Rng,
  teams: Team[],
  rostersByTeam: Map<number, Player[]>,
  draftOrderTeamIds: number[],
): DraftPick[] {
  const needsByTeam = new Map<number, Position[]>()
  const depthCount = new Map<string, number>()
  for (const team of teams) {
    const roster = rostersByTeam.get(team.id) ?? []
    needsByTeam.set(team.id, rosterNeeds(roster))
    for (const p of roster) {
      const key = `${team.id}:${p.position}`
      depthCount.set(key, Math.max(depthCount.get(key) ?? 0, p.depthOrder + 1))
    }
  }

  const allNeededPositions = [...needsByTeam.values()].flat()
  const prospects = allNeededPositions
    .map((pos) => generatePlayer(rng, pos, null))
    .sort((a, b) => b.ratings.overall - a.ratings.overall)

  const picks: DraftPick[] = []
  const maxRounds = Math.max(0, ...[...needsByTeam.values()].map((n) => n.length))

  for (let round = 0; round < maxRounds; round++) {
    for (const teamId of draftOrderTeamIds) {
      const needs = needsByTeam.get(teamId) ?? []
      if (needs.length === 0) continue

      const prospectIndex = prospects.findIndex((p) => needs.includes(p.position))
      if (prospectIndex === -1) continue

      const [prospect] = prospects.splice(prospectIndex, 1)
      needs.splice(needs.indexOf(prospect.position), 1)

      const depthKey = `${teamId}:${prospect.position}`
      const depthOrder = depthCount.get(depthKey) ?? 0
      depthCount.set(depthKey, depthOrder + 1)

      const age = randInt(rng, 21, 23)
      // Rookie deals are well below open-market rate even for a high-overall
      // prospect - draft slot, not proven production, sets rookie pay in
      // real life. Still scales with talent, just heavily discounted.
      const rookieSalary = Math.round(marketSalary(prospect.position, prospect.ratings.overall, age) * 0.35)

      picks.push({
        teamId,
        player: {
          ...prospect,
          teamId,
          age,
          contract: { salary: rookieSalary, yearsLeft: 4 },
          depthOrder,
        },
      })
    }
  }

  return picks
}
