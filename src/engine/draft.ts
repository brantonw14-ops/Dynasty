import { COLLEGES } from './colleges'
import { clamp, generateRatings, potentialGap } from './players'
import { randomName } from './names'
import { createRng, randInt, randNormal, type Rng } from './rng'
import { marketSalary } from './salary'
import type { Player, Position, Ratings } from '../types'

export interface CollegeProspect {
  index: number
  firstName: string
  lastName: string
  position: Position
  age: number
  college: string
  collegeTier: 1 | 2 | 3 | 4
  collegeStatLine: string
  scoutingNote: string
  ratings: Ratings
}

function pickCollege(rng: Rng): (typeof COLLEGES)[number] {
  return COLLEGES[Math.floor(rng() * COLLEGES.length)]
}

/**
 * A fabricated college season stat line, scaled to the prospect's overall
 * and position - flavor for the draft board, not simulated play-by-play.
 */
function collegeStatLine(rng: Rng, position: Position, overall: number): string {
  const talent = Math.max(0, overall - 55) / 32 // 0..~1 over the draft-class range
  switch (position) {
    case 'QB': {
      const yards = Math.round(2000 + talent * 2400 + randNormal(rng, 0, 250))
      const tds = Math.round(14 + talent * 22 + randNormal(rng, 0, 3))
      const ints = Math.max(1, Math.round(14 - talent * 9 + randNormal(rng, 0, 2)))
      return `${yards} pass yds, ${tds} TD, ${ints} INT`
    }
    case 'RB': {
      const yards = Math.round(700 + talent * 1300 + randNormal(rng, 0, 150))
      const tds = Math.round(6 + talent * 14 + randNormal(rng, 0, 2))
      return `${yards} rush yds, ${tds} TD`
    }
    case 'WR':
    case 'TE': {
      const yards = Math.round(500 + talent * 1100 + randNormal(rng, 0, 130))
      const tds = Math.round(4 + talent * 10 + randNormal(rng, 0, 2))
      return `${yards} rec yds, ${tds} TD`
    }
    case 'OL':
      return `${Math.round(9 + talent * 3)} starts, ${Math.max(0, Math.round(6 - talent * 5))} sacks allowed`
    case 'DL':
    case 'LB': {
      const tackles = Math.round(35 + talent * 55 + randNormal(rng, 0, 8))
      const sacks = Math.max(0, Math.round(talent * 9 + randNormal(rng, 0, 1.5)))
      return `${tackles} tkl, ${sacks} sacks`
    }
    case 'CB':
    case 'S': {
      const tackles = Math.round(25 + talent * 40 + randNormal(rng, 0, 6))
      const ints = Math.max(0, Math.round(talent * 5 + randNormal(rng, 0, 1)))
      return `${tackles} tkl, ${ints} INT`
    }
    case 'K': {
      const pct = Math.round(68 + talent * 22)
      return `${Math.min(99, pct)}% FG`
    }
    case 'P':
      return `${(38 + talent * 8 + randNormal(rng, 0, 1.5)).toFixed(1)} yds/punt avg`
    default:
      return ''
  }
}

/**
 * Compares the player's talent to the level of program they played for -
 * did they carry a weaker team, or were they a product of a loaded roster?
 */
function scoutingNote(rng: Rng, overall: number, tier: 1 | 2 | 3 | 4): string {
  if (overall >= 75 && tier >= 3) {
    return "Dominated at a program without much other talent around him - may have carried the offense/defense himself."
  }
  if (overall < 68 && tier === 1) {
    return 'Played in a loaded lineup at a blue-blood program - numbers may owe a lot to the talent around him.'
  }
  if (overall >= 75 && tier === 1) {
    return 'Produced against elite competition on a stacked roster - battle-tested against the best.'
  }
  if (overall < 65 && tier >= 3) {
    return 'Solid tape, but the level of competition faced raises some questions.'
  }
  const neutral = [
    'Steady, if unspectacular, production - a reasonable read on his true talent.',
    'Numbers track closely with his measurables - no real hype or red flags.',
    "Middle-of-the-pack production for the program he played at.",
  ]
  return neutral[Math.floor(rng() * neutral.length)]
}

/**
 * Where a prospect at this draft rank should land on the draft-only overall
 * scale (capped well below the veteran ceiling): the very best prospect in
 * a class tops out at 87, with only the next couple close behind, then it
 * tapers off toward the roster floor by the back of the class - real draft
 * classes have a small handful of true blue-chip prospects, not dozens.
 */
function draftScaleOverall(rank: number, classSize: number): number {
  if (rank === 0) return 87
  if (rank === 1) return 86
  if (rank === 2) return 85
  const t = (rank - 3) / Math.max(1, classSize - 4)
  return clamp(82 - t * 27, 55, 82)
}

function buildProspect(rng: Rng, position: Position, index: number): CollegeProspect {
  const { firstName, lastName } = randomName(rng)
  const age = randInt(rng, 21, 25)
  const college = pickCollege(rng)
  const rawRatings = generateRatings(rng, position, age, 0)
  return {
    index,
    firstName,
    lastName,
    position,
    age,
    college: college.name,
    collegeTier: college.tier,
    collegeStatLine: '',
    scoutingNote: '',
    ratings: rawRatings,
  }
}

/** Rescales a prospect's three attributes (and recomputed overall/potential) to hit an exact target overall, preserving their relative shape. */
function rescaleToOverall(rng: Rng, position: Position, age: number, ratings: Ratings, targetOverall: number): Ratings {
  const scale = ratings.overall > 0 ? targetOverall / ratings.overall : 1
  const attr1 = clamp(ratings.attr1 * scale)
  const attr2 = clamp(ratings.attr2 * scale)
  const attr3 = clamp(ratings.attr3 * scale)
  const overall = clamp((attr1 + attr2 + attr3) / 3, 55, 87)
  const potential = clamp(overall + potentialGap(rng, position, age), overall, 99)
  return { overall, potential, attr1, attr2, attr3 }
}

/**
 * Generates a full draft class: one prospect per needed position across the
 * league, with a real college + prestige tier, a fabricated college stat
 * line, a scouting note comparing talent to competition level, and an
 * overall rating on the compressed draft scale (see draftScaleOverall).
 * Deterministic from the seed, so it can be safely regenerated on demand
 * instead of persisted - the draft-in-progress state (who's already been
 * picked) lives separately.
 */
export function generateDraftClass(seed: number, positions: Position[]): CollegeProspect[] {
  const rng = createRng(seed)
  const prospects = positions.map((pos, i) => buildProspect(rng, pos, i))
  const ranked = [...prospects].sort((a, b) => b.ratings.overall - a.ratings.overall)

  ranked.forEach((prospect, rank) => {
    const target = draftScaleOverall(rank, ranked.length)
    prospect.ratings = rescaleToOverall(rng, prospect.position, prospect.age, prospect.ratings, target)
    prospect.collegeStatLine = collegeStatLine(rng, prospect.position, prospect.ratings.overall)
    prospect.scoutingNote = scoutingNote(rng, prospect.ratings.overall, prospect.collegeTier)
  })

  return prospects
}

/** Converts a drafted prospect into an actual roster player, on a below-market rookie deal. */
export function prospectToPlayer(prospect: CollegeProspect, teamId: number, depthOrder: number): Omit<Player, 'id'> {
  // Rookie deals are well below open-market rate even for a high-overall
  // prospect - draft slot, not proven production, sets rookie pay in real
  // life. Still scales with talent, just heavily discounted.
  const rookieSalary = Math.round(marketSalary(prospect.position, prospect.ratings.overall, prospect.age) * 0.35)
  return {
    firstName: prospect.firstName,
    lastName: prospect.lastName,
    age: prospect.age,
    position: prospect.position,
    teamId,
    ratings: prospect.ratings,
    contract: { salary: rookieSalary, yearsLeft: 4 },
    retired: false,
    injury: null,
    depthOrder,
  }
}
