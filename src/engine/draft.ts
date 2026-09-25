import type { Player, Position, Team } from '../types'
import { generatePlayer, rosterNeeds } from './players'
import { randInt, type Rng } from './rng'

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
  for (const team of teams) {
    needsByTeam.set(team.id, rosterNeeds(rostersByTeam.get(team.id) ?? []))
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

      picks.push({
        teamId,
        player: {
          ...prospect,
          teamId,
          age: randInt(rng, 21, 23),
          contract: { salary: randInt(rng, 700_000, 1_200_000), yearsLeft: 4 },
        },
      })
    }
  }

  return picks
}
