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

  // 1 remaining cross-conference game per team, as an actual perfect matching
  // (every AFC team gets exactly one extra NFC opponent and vice versa) - a
  // plain greedy pass here can dead-end for a team late in the loop (all its
  // valid candidates already claimed) and silently leave both it and its
  // would-be partner one game short, so this uses a real maximum-bipartite-
  // matching algorithm (guaranteed to find a perfect matching whenever one
  // exists, which it always does here given how sparse `seen` is).
  const afcTeams = [...divisionTeamsFlat(byDivision, 'AFC')]
  const nfcTeams = [...divisionTeamsFlat(byDivision, 'NFC')]
  shuffleInPlace(afcTeams, season, 1)
  shuffleInPlace(nfcTeams, season, 2)
  const extraPairs = maxBipartiteMatching(afcTeams, nfcTeams, (a, b) => !seen.has(pairKey(a, b)))
  const nfcById = new Map(nfcTeams.map((t) => [t.id, t]))
  for (const [afcId, nfcId] of extraPairs) {
    const afc = afcTeams.find((t) => t.id === afcId)!
    addSingleGame(afc, nfcById.get(nfcId)!)
  }

  return matchups
}

function divisionTeamsFlat(byDivision: Map<string, Team[]>, conference: Conference): Team[] {
  return ALL_DIVISIONS.flatMap((d) => byDivision.get(`${conference}-${d}`) ?? [])
}

/**
 * Kuhn's algorithm: finds a maximum matching between `left` and `right`
 * teams whose id pairs satisfy `allowed`. Unlike a single greedy pass, this
 * is guaranteed to find a perfect matching whenever one exists - it can
 * always "bump" an already-matched right node to a different left node to
 * make room, rather than just giving up when the first-come greedy choice
 * blocks a later node.
 */
function maxBipartiteMatching(
  left: Team[],
  right: Team[],
  allowed: (leftId: number, rightId: number) => boolean,
): Array<[number, number]> {
  const adjacency = new Map<number, number[]>()
  for (const l of left) {
    adjacency.set(
      l.id,
      right.filter((r) => allowed(l.id, r.id)).map((r) => r.id),
    )
  }

  const matchOfRight = new Map<number, number>()

  const tryAugment = (leftId: number, visited: Set<number>): boolean => {
    for (const rightId of adjacency.get(leftId) ?? []) {
      if (visited.has(rightId)) continue
      visited.add(rightId)
      const currentMatch = matchOfRight.get(rightId)
      if (currentMatch === undefined || tryAugment(currentMatch, visited)) {
        matchOfRight.set(rightId, leftId)
        return true
      }
    }
    return false
  }

  for (const l of left) {
    tryAugment(l.id, new Set())
  }

  return [...matchOfRight.entries()].map(([rightId, leftId]) => [leftId, rightId])
}

/** Deterministic shuffle so the same season always produces the same schedule. */
function shuffleInPlace<T>(arr: T[], seed: number, salt: number) {
  let state = (seed * 2654435761 + salt * 40503) >>> 0
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

/**
 * Picks a maximal matching (no team plays twice) from the remaining games for
 * one week. Purely random ordering tends to strand a growing pile of games
 * for teams that happen to get skipped early, which snowballs into a long,
 * thin tail of near-empty weeks. Prioritizing matchups whose teams have the
 * fewest games left elsewhere (most constrained first, a standard graph
 * coloring heuristic) keeps the weekly matchings close to maximum instead.
 */
function bestWeekMatching(
  remaining: Matchup[],
  remainingDegree: Map<number, number>,
  teamCount: number,
  rng: () => number,
): number[] {
  const attempts = 200
  const maxPossible = Math.floor(teamCount / 2)
  let best: number[] = []

  for (let attempt = 0; attempt < attempts && best.length < maxPossible; attempt++) {
    const scored = remaining.map((m, i) => ({
      i,
      // Small random jitter keeps attempts diverse while still favoring scarce teams.
      key:
        Math.min(remainingDegree.get(m.a)!, remainingDegree.get(m.b)!) * 10 + rng(),
    }))
    scored.sort((x, y) => x.key - y.key)

    const busy = new Set<number>()
    const chosen: number[] = []
    for (const { i } of scored) {
      const m = remaining[i]
      if (!busy.has(m.a) && !busy.has(m.b)) {
        busy.add(m.a)
        busy.add(m.b)
        chosen.push(i)
      }
    }

    if (chosen.length > best.length) best = chosen
  }

  return best
}

// 8 bye weeks (roughly the real NFL's window) so 32 teams split evenly at 4
// per week - an odd count would leave one team with nobody to play that week.
const BYE_WEEK_RANGE = { start: 5, end: 12 }

/**
 * Gives every team exactly one bye week, spread evenly across the candidate
 * range, like the real NFL's 18-week/17-game/1-bye structure. A 17-regular
 * graph on 32 teams isn't always packable into a tight 17-week season (some
 * such graphs genuinely need an 18th color/week - a real graph theory limit,
 * not just a search-quality issue), so building in this one week of slack
 * per team up front makes near-full weekly matchings reliable instead of
 * leaving it to chance.
 */
function assignByeWeeks(teams: Team[], season: number): Map<number, number> {
  const byeWeeks: number[] = []
  for (let w = BYE_WEEK_RANGE.start; w <= BYE_WEEK_RANGE.end; w++) byeWeeks.push(w)

  const shuffled = [...teams]
  shuffleInPlace(shuffled, season, 999)

  const byeWeekOf = new Map<number, number>()
  shuffled.forEach((team, i) => {
    byeWeekOf.set(team.id, byeWeeks[i % byeWeeks.length])
  })
  return byeWeekOf
}

/**
 * Packs games into a season respecting each team's assigned bye week, so
 * every non-bye team plays every week. Falls back to extending past the
 * target length only if some pairing genuinely can't be placed within the
 * built-in slack (should be rare to never in practice).
 */
function assignWeeks(
  matchups: Matchup[],
  teams: Team[],
  season: number,
  rng: () => number,
): ScheduledGame[] {
  const byeWeekOf = assignByeWeeks(teams, season)
  // 272 games needs 17 weeks at a full 16/week, but the 8 bye weeks only
  // supply 14 games each - so the plain weeks alone (64 + 96 = 160 games)
  // plus the bye weeks (112 games) land at exactly 272 with zero slack.
  // A couple of extra full-capacity weeks gives the matcher room to breathe
  // instead of requiring every single week to pack perfectly.
  const totalWeeks = 20

  const remaining = [...matchups]
  const remainingDegree = new Map<number, number>()
  for (const m of remaining) {
    remainingDegree.set(m.a, (remainingDegree.get(m.a) ?? 0) + 1)
    remainingDegree.set(m.b, (remainingDegree.get(m.b) ?? 0) + 1)
  }

  const games: ScheduledGame[] = []

  const playWeek = (week: number) => {
    const onByeThisWeek = new Set(
      [...byeWeekOf.entries()].filter(([, w]) => w === week).map(([id]) => id),
    )
    const available = remaining
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !onByeThisWeek.has(m.a) && !onByeThisWeek.has(m.b))

    const activeTeamCount = teams.length - onByeThisWeek.size
    const chosenIdx = bestWeekMatching(
      available.map(({ m }) => m),
      remainingDegree,
      activeTeamCount,
      rng,
    ).map((localIdx) => available[localIdx].i)
    const chosenSet = new Set(chosenIdx)

    for (const idx of chosenIdx) {
      const m = remaining[idx]
      const homeFirst = rng() < 0.5
      games.push({
        week,
        homeTeamId: homeFirst ? m.a : m.b,
        awayTeamId: homeFirst ? m.b : m.a,
      })
      remainingDegree.set(m.a, remainingDegree.get(m.a)! - 1)
      remainingDegree.set(m.b, remainingDegree.get(m.b)! - 1)
    }

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (chosenSet.has(i)) remaining.splice(i, 1)
    }
  }

  for (let week = 1; week <= totalWeeks && remaining.length > 0; week++) {
    playWeek(week)
  }

  // Safety net: place anything left (should be empty in practice) into extra weeks.
  let week = totalWeeks + 1
  while (remaining.length > 0) {
    playWeek(week)
    week++
  }

  return games
}

function scoreSchedule(games: ScheduledGame[]): number {
  const byWeek = new Map<number, number>()
  for (const g of games) byWeek.set(g.week, (byWeek.get(g.week) ?? 0) + 1)
  const totalWeeks = Math.max(...byWeek.keys())

  // Heavily penalize extra weeks, then penalize any week that isn't close to
  // a full slate (thin/straggling weeks are what we're actually trying to avoid).
  let thinness = 0
  for (const count of byWeek.values()) thinness += Math.max(0, 14 - count) ** 2

  return totalWeeks * 10_000 + thinness
}

/**
 * A single scheduling attempt can still land an uneven tail depending on
 * which random choices it makes along the way (the underlying game graph
 * isn't always equally packable no matter how it's built). Since one
 * attempt is cheap, generate several full candidate schedules and keep
 * whichever is shortest and most evenly packed.
 */
export function generateSchedule(
  teams: Team[],
  season: number,
  rng: () => number,
): ScheduledGame[] {
  const matchups = buildSeasonMatchups(teams, season)
  const attempts = 40
  let best: ScheduledGame[] | null = null
  let bestScore = Infinity

  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = assignWeeks(matchups, teams, season, rng)
    const score = scoreSchedule(candidate)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best!
}
