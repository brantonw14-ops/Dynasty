import type { Player, Position, Team } from '../types'
import { nextDepthOrder, rosterNeeds } from './players'
import { randInt, type Rng } from './rng'
import { marketSalary } from './salary'
import { SALARY_CAP } from './teams'

/** Remaining budget to spend this offseason: full cap minus rostered salaries. */
export function computeCapSpace(roster: Player[]) {
  const committed = roster.reduce((sum, p) => sum + (p.contract?.salary ?? 0), 0)
  return Math.max(0, SALARY_CAP - committed)
}

function estimateSalary(rng: Rng, position: Position, overall: number, age: number) {
  return Math.round(marketSalary(position, overall, age) * (0.9 + rng() * 0.25))
}

/** How likely a team is to proactively re-sign a player before his contract ever hits the open market. */
function retentionChance(overall: number) {
  if (overall >= 80) return 0.9
  if (overall >= 70) return 0.65
  if (overall >= 60) return 0.35
  return 0.1
}

/**
 * Same yearly contract aging as expireContracts, but AI teams (every team
 * except the user's) get a chance to proactively re-sign a player whose
 * deal is about to expire, before he ever reaches the open market - just
 * like real front offices extend the players they actually want to keep.
 * The better the player, the more likely; a team never extends itself
 * into being unable to afford the deal. Without this, every expiring
 * contract league-wide (AI or user) hit free agency uncontested, flooding
 * the pool with far more quality talent than real NFL free agency ever
 * has - most good players get retained by their own team in real life,
 * and only the ones a team doesn't prioritize actually reach the market.
 */
export function expireContractsWithAiRetention(rng: Rng, players: Player[], userTeamId: number | null): Player[] {
  const committedByTeam = new Map<number, number>()
  for (const p of players) {
    if (p.teamId != null && p.contract && p.contract.yearsLeft > 1) {
      committedByTeam.set(p.teamId, (committedByTeam.get(p.teamId) ?? 0) + p.contract.salary)
    }
  }

  return players.map((p) => {
    if (p.teamId === null || !p.contract) return p
    const yearsLeft = p.contract.yearsLeft - 1
    if (yearsLeft > 0) return { ...p, contract: { ...p.contract, yearsLeft } }

    // Contract is expiring this offseason.
    if (p.teamId === userTeamId) return { ...p, contract: null }

    if (rng() < retentionChance(p.ratings.overall)) {
      const newSalary = estimateSalary(rng, p.position, p.ratings.overall, p.age)
      const committed = committedByTeam.get(p.teamId) ?? 0
      if (committed + newSalary <= SALARY_CAP * 0.95) {
        committedByTeam.set(p.teamId, committed + newSalary)
        return { ...p, contract: { salary: newSalary, yearsLeft: randInt(rng, 1, 3) } }
      }
    }

    return { ...p, teamId: null, contract: null }
  })
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
        const salary = estimateSalary(rng, p.position, p.ratings.overall, p.age)
        return salary <= salaryCap
      })
      if (candidateIndex === -1) continue

      const [player] = pool.splice(candidateIndex, 1)
      const salary = estimateSalary(rng, player.position, player.ratings.overall, player.age)
      needs.splice(needs.indexOf(player.position), 1)
      capRemaining.set(teamId, salaryCap - salary)

      const teamRoster = rostersByTeam.get(teamId) ?? []
      const signedPlayer = {
        ...player,
        teamId,
        contract: { salary, yearsLeft: randInt(rng, 1, 3) },
        depthOrder: nextDepthOrder(teamRoster, player.position),
      }
      teamRoster.push(signedPlayer)

      signings.push({ teamId, player: signedPlayer, salary })
      madeProgress = true
    }
  }

  return signings
}
