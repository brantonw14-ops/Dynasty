import type { Conference, Division, Team } from '../types'

export interface ScheduledGame {
  week: number
  homeTeamId: number
  awayTeamId: number
}

const ALL_DIVISIONS: Division[] = ['East', 'North', 'South', 'West']

// The 3 ways to partition 4 divisions into 2 pairs, for the "full round vs one
// other division" rotation the real NFL uses (every division gets a partner
// division each season; the partner rotates on a 3-year cycle).
const CONFERENCE_PAIRINGS: [Division, Division][][] = [
  [
    ['East', 'North'],
    ['South', 'West'],
  ],
  [
    ['East', 'South'],
    ['North', 'West'],
  ],
  [
    ['East', 'West'],
    ['North', 'South'],
  ],
]

interface Matchup {
  a: number
  b: number
}

function partnerDivision(division: Division, pairing: [Division, Division][]): Division {
  for (const [x, y] of pairing) {
    if (x === division) return y
    if (y === division) return x
  }
  throw new Error(`Division ${division} missing from pairing`)
}

/**
 * Approximates the real NFL 17-game schedule formula:
 *  - 6 games vs the 3 division rivals (home + away)
 *  - 4 games vs one full division from the same conference (rotates every 3 seasons)
 *  - 4 games vs one full division from the other conference (rotates every 4 seasons)
 *  - 2 games vs the two remaining same-conference divisions, matched by roster slot
 *  - 1 game vs one remaining other-conference division, matched by roster slot
 * Team "slot" is its index (0-3) within its own division, standing in for the real
 * league's prior-season-rank matchups since no history exists in season 1.
 */
export function buildSeasonMatchups(teams: Team[], season: number): Matchup[] {
  const byDivision = new Map<string, Team[]>()
  for (const t of teams) {
    const key = `${t.conference}-${t.division}`
    const list = byDivision.get(key) ?? []
    list.push(t)
    byDivision.set(key, list)
  }
  for (const list of byDivision.values()) list.sort((a, b) => a.id - b.id)

  const divisionTeams = (conference: Conference, division: Division) =>
    byDivision.get(`${conference}-${division}`)!

  const slotOf = (team: Team) => divisionTeams(team.conference, team.division).indexOf(team)

  const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
  const seen = new Set<string>()
  const matchups: Matchup[] = []

  const addFullRound = (teamsA: Team[], teamsB: Team[]) => {
    for (const a of teamsA) {
      for (const b of teamsB) {
        const key = pairKey(a.id, b.id)
        if (seen.has(key)) continue
        seen.add(key)
        matchups.push({ a: a.id, b: b.id })
      }
    }
  }

  const addSingleGame = (a: Team, b: Team) => {
    const key = pairKey(a.id, b.id)
    if (seen.has(key)) return
    seen.add(key)
    matchups.push({ a: a.id, b: b.id })
  }

  // Division rivals, twice each (home + away).
  for (const team of teams) {
    const rivals = divisionTeams(team.conference, team.division).filter((t) => t.id !== team.id)
    for (const rival of rivals) matchups.push({ a: team.id, b: rival.id })
  }

  // Same-conference primary partner division (full round, 4 games/team).
  const conferencePairing = CONFERENCE_PAIRINGS[season % CONFERENCE_PAIRINGS.length]
  for (const conference of ['AFC', 'NFC'] as Conference[]) {
    for (const [d1, d2] of conferencePairing) {
      addFullRound(divisionTeams(conference, d1), divisionTeams(conference, d2))
    }
  }

  // Cross-conference primary partner division (full round, 4 games/team),
  // a fixed-shift bijection so AFC<->NFC pairing is mutually consistent.
  const crossShift = season % ALL_DIVISIONS.length
  const crossPartner = (division: Division) =>
    ALL_DIVISIONS[(ALL_DIVISIONS.indexOf(division) + crossShift) % ALL_DIVISIONS.length]
  for (const afcDivision of ALL_DIVISIONS) {
    const nfcDivision = crossPartner(afcDivision)
    addFullRound(divisionTeams('AFC', afcDivision), divisionTeams('NFC', nfcDivision))
  }

  // Remaining 2 same-conference divisions: 1 game each, matched by slot.
  for (const team of teams) {
    const partner = partnerDivision(team.division, conferencePairing)
    const remaining = ALL_DIVISIONS.filter((d) => d !== team.division && d !== partner)
    const slot = slotOf(team)
    for (const d of remaining) {
      const opp = divisionTeams(team.conference, d)[slot]
      if (opp) addSingleGame(team, opp)
    }
  }

  // 1 remaining cross-conference game, matched by slot.
  for (const team of teams) {
    const otherConference: Conference = team.conference === 'AFC' ? 'NFC' : 'AFC'
    const crossDivision =
      team.conference === 'AFC' ? crossPartner(team.division) : undefined
    const pairedOtherDivision =
      team.conference === 'AFC'
        ? crossDivision!
        : ALL_DIVISIONS.find((d) => crossPartner(d) === team.division)!
    const remainingCross = ALL_DIVISIONS.filter((d) => d !== pairedOtherDivision)
    const slot = slotOf(team)
    const pick = remainingCross[(season + slot) % remainingCross.length]
    const opp = divisionTeams(otherConference, pick)[slot]
    if (opp) addSingleGame(team, opp)
  }

  return matchups
}

/** Greedily packs games into weeks so no team plays twice in the same week. */
function assignWeeks(matchups: Matchup[], rng: () => number): ScheduledGame[] {
  const remaining = [...matchups]
  // Shuffle for variety in home/away and week grouping.
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[remaining[i], remaining[j]] = [remaining[j], remaining[i]]
  }

  const games: ScheduledGame[] = []
  let week = 1
  while (remaining.length > 0) {
    const busy = new Set<number>()
    for (let i = 0; i < remaining.length; ) {
      const m = remaining[i]
      if (!busy.has(m.a) && !busy.has(m.b)) {
        busy.add(m.a)
        busy.add(m.b)
        const homeFirst = rng() < 0.5
        games.push({
          week,
          homeTeamId: homeFirst ? m.a : m.b,
          awayTeamId: homeFirst ? m.b : m.a,
        })
        remaining.splice(i, 1)
      } else {
        i++
      }
    }
    week++
  }

  return games
}

export function generateSchedule(
  teams: Team[],
  season: number,
  rng: () => number,
): ScheduledGame[] {
  const matchups = buildSeasonMatchups(teams, season)
  return assignWeeks(matchups, rng)
}
