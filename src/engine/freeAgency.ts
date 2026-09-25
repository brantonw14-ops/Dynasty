import type { Player, Team } from '../types'
import { rosterNeeds } from './players'
import { randInt, type Rng } from './rng'
import { marketSalary } from './salary'
import { SALARY_CAP } from './teams'

/** Remaining budget to spend this offseason: full cap minus rostered salaries. */
export function computeCapSpace(roster: Player[]) {
  const committed = roster.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
  return Math.max(0, SALARY_CAP - committed)
}

/**
 * Ages every contract by a year. A contract that hits 0 years left expires:
 * the player becomes a free agent (teamId/contract cleared) so they're
 * available to be re-signed in free agency rather than staying locked to
 * a team forever.
 */
export function expireContracts(players: Player[]): Player[] {
  return players.map((p) => {
    if (p.teamId === null || !p.contract) return p
    const yearsLeft = p.contract.yearsLeft - 1
    if (yearsLeft <= 0) {
      return { ...p, teamId: null, contract: null }
    }
    return { ...p, contract: { ...p.contract, yearsLeft } }
  })
}

function estimateSalary(rng: Rng, overall: number, age: number) {
  return Math.round(marketSalary(overall, age) * (0.9 + rng() * 0.25))
}

export interface FreeAgentSigning {
  teamId: number
  player: Player
  salary: number
}

/**
 * Simple AI free agency: each team (worst record first, so weaker teams get
 * first pick of the pool - mirrors real free agency's cap-space dynamics
 * loosely) signs the best available free agent at a position it still
 * needs, as long as the salary fits its remaining cap space. Repeats until
 * every team is full or the pool runs out of useful players.
 */
export function runFreeAgency(
  rng: Rng,
  teams: Team[],
  rostersByTeam: Map<number, Player[]>,
  freeAgents: Player[],
  signingOrderTeamIds: number[],
  excludeTeamIds: Set<number> = new Set(),
): FreeAgentSigning[] {
  const pool = [...freeAgents].sort((a, b) => b.ratings.overall - a.ratings.overall)
  const capRemaining = new Map(
    teams.map((t) => [t.id, computeCapSpace(rostersByTeam.get(t.id) ?? [])]),
  )
  const needsByTeam = new Map(
    teams.map((t) => [t.id, rosterNeeds(rostersByTeam.get(t.id) ?? [])]),
  )

  const signings: FreeAgentSigning[] = []
  let madeProgress = true

  while (madeProgress && pool.length > 0) {
    madeProgress = false

    for (const teamId of signingOrderTeamIds) {
      if (excludeTeamIds.has(teamId)) continue
      const needs = needsByTeam.get(teamId)
      if (!needs || needs.length === 0) continue

      const salaryCap = capRemaining.get(teamId) ?? 0
      const candidateIndex = pool.findIndex((p) => {
        if (!needs.includes(p.position)) return false
        const salary = estimateSalary(rng, p.ratings.overall, p.age)
        return salary <= salaryCap
      })
      if (candidateIndex === -1) continue

      const [player] = pool.splice(candidateIndex, 1)
      const salary = estimateSalary(rng, player.ratings.overall, player.age)
      needs.splice(needs.indexOf(player.position), 1)
      capRemaining.set(teamId, salaryCap - salary)

      signings.push({
        teamId,
        player: { ...player, teamId, contract: { salary, yearsLeft: randInt(rng, 1, 3) } },
        salary,
      })
      madeProgress = true
    }
  }

  return signings
}
