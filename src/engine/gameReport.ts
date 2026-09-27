import type { PlayerGameStats, Position } from '../types'
import { passerRating } from './gameSim'
import type { SeasonGrade } from './seasonPerformance'

export type GameOutcomeTag = 'good' | 'bad'

/**
 * Whether a single game was clearly a good or bad one for this player.
 * Primarily driven by the same league-wide letter grade (A-F, z-scored
 * against position peers for that week) shown on the box score - an A
 * played well, an F played poorly, so the two views of a game agree with
 * each other instead of using separate ad-hoc thresholds. `weekGrade` is
 * that grade for this exact stat line (pass `undefined` if none - too few
 * peers that position/week to grade).
 *
 * A couple of position-specific overrides on top of the grade:
 * - A kicker missing even one extra point is always "bad" - a PAT is a
 *   routine, near-automatic play in the real league, not a coin flip.
 * - A kicker who only attempted PATs (no field goals) never grades "good"
 *   just for being perfect on them - that's the expectation, not a
 *   standout game.
 */
export function classifyGamePerformance(
  position: Position,
  s: PlayerGameStats,
  weekGrade?: SeasonGrade,
): GameOutcomeTag | null {
  if (position === 'K') {
    const patMissed = s.extraPointsAttempted - s.extraPointsMade
    if (patMissed >= 1) return 'bad'
    if (s.fieldGoalsAttempted === 0) return null
  }
  if (position === 'QB' && s.passAttempts < 5) return null
  if (position === 'RB' && s.rushAttempts < 5) return null

  if (weekGrade === 'A') return 'good'
  if (weekGrade === 'F') return 'bad'
  return null
}

/** A one-line human-readable blurb backing up why this performance was tagged good/bad. */
export function performanceBlurb(position: Position, s: PlayerGameStats, tag: GameOutcomeTag): string {
  switch (position) {
    case 'QB': {
      const rating = passerRating(s.passAttempts, s.passCompletions, s.passYards, s.passTDs, s.interceptions)
      return `${s.passCompletions}/${s.passAttempts}, ${s.passYards} yds, ${s.passTDs} TD, ${s.interceptions} INT (${rating.toFixed(1)} rating)`
    }
    case 'RB':
      return `${s.rushAttempts} car, ${s.rushYards} yds (${(s.rushYards / Math.max(1, s.rushAttempts)).toFixed(1)} ypc)`
    case 'WR':
    case 'TE':
      return `${s.receptions} rec, ${s.recYards} yds, ${s.recTDs} TD`
    case 'OL':
      return tag === 'good' ? `${s.pancakes} pancakes, no sacks allowed` : `${s.sacksAllowed} sacks allowed`
    case 'DL':
    case 'LB':
      return `${s.sacks} sacks, ${s.tacklesForLoss} TFL, ${s.tackles} tkl`
    case 'CB':
    case 'S':
      return tag === 'good' ? `${s.defInterceptions} INT, ${s.passBreakups} PBU` : `${s.yardsAllowed} yds allowed`
    case 'K': {
      const missed = s.fieldGoalsAttempted - s.fieldGoalsMade + (s.extraPointsAttempted - s.extraPointsMade)
      return tag === 'good' ? `${s.fieldGoalsMade}/${s.fieldGoalsAttempted} FG, perfect on PATs` : `${missed} missed kick(s)`
    }
    default:
      return ''
  }
}

export interface HeadlinePlayer {
  playerId: number
  firstName: string
  lastName: string
  position: Position
  overall: number
  stat: PlayerGameStats
}

/** Below this, a player is "just a guy" on the roster - a big game from
 * someone this low is a real surprise, not just a star doing star things. */
const BREAKOUT_OVERALL_CEILING = 68

/**
 * The story of the game, not just the box score - a handful of headline-
 * worthy moments (a signature performance, a breakout from an unheralded
 * player, a defensive takeover, a walk-off kick) so the same names start
 * showing up again and again and a GM gets attached to their roster, not
 * just a stat line. Ordered most-notable-first and capped at 3 so this
 * reads like a recap, not a second box score.
 */
export function buildGameHeadlines(
  players: HeadlinePlayer[],
  won: boolean,
  myScore: number,
  oppScore: number,
): string[] {
  const margin = Math.abs(myScore - oppScore)
  const name = (p: HeadlinePlayer) => `${p.firstName} ${p.lastName}`
  const headlines: { text: string; priority: number }[] = []

  for (const p of players) {
    const s = p.stat
    switch (p.position) {
      case 'QB': {
        if (s.passAttempts < 15) break
        const rating = passerRating(s.passAttempts, s.passCompletions, s.passYards, s.passTDs, s.interceptions)
        if (won && margin <= 8 && rating >= 100) {
          headlines.push({
            text: `${name(p)} delivered when it mattered most - a ${rating.toFixed(1)} passer rating to seal a ${margin}-point win.`,
            priority: 1,
          })
        } else if (s.passYards >= 350 || (s.passTDs >= 4 && s.interceptions === 0)) {
          headlines.push({
            text: `${name(p)} was nearly unstoppable - ${s.passYards} yds, ${s.passTDs} TD, ${s.interceptions} INT.`,
            priority: 2,
          })
        } else if (p.overall < BREAKOUT_OVERALL_CEILING && rating >= 105) {
          headlines.push({
            text: `${name(p)} came out of nowhere - a ${p.overall} overall arm posting a ${rating.toFixed(1)} rating nobody expected.`,
            priority: 3,
          })
        }
        break
      }
      case 'RB': {
        if (s.rushYards >= 150 || s.rushTDs >= 3) {
          headlines.push({
            text: `${name(p)} put together one of the best nights of his career - ${s.rushYards} yds and ${s.rushTDs} TD on the ground.`,
            priority: 2,
          })
        } else if (p.overall < BREAKOUT_OVERALL_CEILING && s.rushYards >= 90) {
          headlines.push({
            text: `${name(p)} broke out - ${s.rushYards} yards is a career night for a ${p.overall} overall back.`,
            priority: 3,
          })
        }
        break
      }
      case 'WR':
      case 'TE': {
        if (s.recYards >= 150 || s.recTDs >= 3) {
          headlines.push({
            text: `${name(p)} torched the secondary - ${s.receptions} rec, ${s.recYards} yds, ${s.recTDs} TD.`,
            priority: 2,
          })
        } else if (p.overall < BREAKOUT_OVERALL_CEILING && s.recYards >= 90) {
          headlines.push({
            text: `${name(p)} had a breakout game - ${s.recYards} yards from a ${p.overall} overall target nobody game-planned for.`,
            priority: 3,
          })
        }
        break
      }
      case 'DL':
      case 'LB':
      case 'CB':
      case 'S': {
        if (s.sacks >= 3 || s.defInterceptions >= 2) {
          headlines.push({
            text: `${name(p)} took the game over on defense - ${s.sacks} sacks, ${s.defInterceptions} INT, ${s.passBreakups} PBU.`,
            priority: 2,
          })
        }
        break
      }
      case 'K': {
        if (s.fieldGoalsMade > 0 && s.longestFieldGoal >= 50 && margin <= 3 && won) {
          headlines.push({
            text: `${name(p)} drilled a ${s.longestFieldGoal}-yard game-winner as time wound down.`,
            priority: 1,
          })
        }
        break
      }
      default:
        break
    }
  }

  const turnoversCommitted = players
    .filter((p) => p.position === 'QB')
    .reduce((sum, p) => sum + p.stat.interceptions, 0)
  if (!won && turnoversCommitted >= 3) {
    headlines.push({ text: `Turnovers doomed this one - ${turnoversCommitted} giveaways nobody could overcome.`, priority: 2 })
  }

  return headlines
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3)
    .map((h) => h.text)
}

interface TeamGameTotals {
  turnoversCommitted: number
  turnoversForced: number
  sacksAllowed: number
  sacksMade: number
  passYardsAllowed: number
  fieldGoalsMissed: number
}

function aggregateTeamTotals(stats: PlayerGameStats[]): TeamGameTotals {
  const totals: TeamGameTotals = {
    turnoversCommitted: 0,
    turnoversForced: 0,
    sacksAllowed: 0,
    sacksMade: 0,
    passYardsAllowed: 0,
    fieldGoalsMissed: 0,
  }
  for (const s of stats) {
    totals.turnoversCommitted += s.interceptions
    totals.turnoversForced += s.defInterceptions
    totals.sacksAllowed += s.sacksAllowed
    totals.sacksMade += s.sacks
    totals.passYardsAllowed += s.yardsAllowed
    totals.fieldGoalsMissed += s.fieldGoalsAttempted - s.fieldGoalsMade + (s.extraPointsAttempted - s.extraPointsMade)
  }
  return totals
}

/**
 * A plain-English list of what actually decided the game, derived from the
 * box score differential rather than any hidden narrative state - turnovers,
 * pass protection, pass rush, pass defense, and kicking are the categories a
 * box score can actually speak to.
 */
export function buildGameReasons(myStats: PlayerGameStats[], won: boolean, myScore: number, oppScore: number): string[] {
  const mine = aggregateTeamTotals(myStats)
  const reasons: string[] = []

  const turnoverMargin = mine.turnoversForced - mine.turnoversCommitted
  if (turnoverMargin < 0) {
    reasons.push(
      `Turned the ball over ${mine.turnoversCommitted} time(s) while forcing only ${mine.turnoversForced} - a ${turnoverMargin} turnover margin.`,
    )
  } else if (turnoverMargin > 0) {
    reasons.push(
      `Won the turnover battle (+${turnoverMargin}) - forced ${mine.turnoversForced} takeaway(s) while giving up only ${mine.turnoversCommitted}.`,
    )
  }

  if (mine.sacksAllowed >= 3) {
    reasons.push(`Offensive line allowed ${mine.sacksAllowed} sacks - protection broke down.`)
  }
  if (mine.sacksMade >= 3) {
    reasons.push(`Pass rush got home ${mine.sacksMade} times - a big night up front on defense.`)
  }

  if (mine.passYardsAllowed >= 280) {
    reasons.push(`Pass defense allowed ${mine.passYardsAllowed} yards through the air - secondary got exposed.`)
  }

  if (mine.fieldGoalsMissed > 0) {
    reasons.push(`Missed ${mine.fieldGoalsMissed} kick(s) - points left on the field.`)
  }

  const margin = Math.abs(myScore - oppScore)
  if (reasons.length === 0) {
    reasons.push(
      won
        ? 'A clean, well-rounded win - no single unit gave the game away.'
        : `A close, even game (${margin}-point margin) - no glaring weakness, just came up short.`,
    )
  }

  return reasons
}

export interface CoachReportKey {
  label: string
  succeeded: boolean
  detail: string
  /** A concrete roster move to consider - only set when the key failed. */
  improvementTip?: string
}

export interface CoachReport {
  /** 1-10, like a coach grading his own team's performance against a specific opponent. */
  grade: number
  keys: CoachReportKey[]
}

function sumRushing(stats: PlayerGameStats[]) {
  return stats.reduce(
    (acc, s) => {
      acc.yards += s.rushYards
      acc.attempts += s.rushAttempts
      return acc
    },
    { yards: 0, attempts: 0 },
  )
}

/** Total offensive output/plays for a team's game - used to judge explosiveness (yards per play) without needing a real play-by-play log. */
function sumOffense(stats: PlayerGameStats[]) {
  return stats.reduce(
    (acc, s) => {
      acc.yards += s.passYards + s.rushYards
      acc.plays += s.passAttempts + s.rushAttempts
      return acc
    },
    { yards: 0, plays: 0 },
  )
}

/**
 * The head coach's report to the GM: a handful of "keys to the game" - the
 * things that actually mattered against this specific opponent - each
 * graded pass/fail with a concrete reason and, when it failed, a roster
 * move worth considering. This is the same shape a real coordinator's
 * post-game self-scout uses (establish the run, protect the QB, win
 * the turnover battle, generate pressure, defend the run and pass,
 * finish in the kicking game) rather than a prose recap - a GM should be
 * able to scan it and know exactly what to go fix.
 */
export function buildCoachReport(myStats: PlayerGameStats[], oppStats: PlayerGameStats[]): CoachReport {
  const mine = aggregateTeamTotals(myStats)
  const myRushing = sumRushing(myStats)
  const oppRushing = sumRushing(oppStats)
  const myYpc = myRushing.yards / Math.max(1, myRushing.attempts)

  const keys: CoachReportKey[] = []

  const qbLine = myStats.find((s) => s.position === 'QB' && s.passAttempts > 0)
  if (qbLine) {
    const rating = passerRating(qbLine.passAttempts, qbLine.passCompletions, qbLine.passYards, qbLine.passTDs, qbLine.interceptions)
    keys.push({
      label: 'Quarterback Play',
      succeeded: rating >= 90,
      detail: `${qbLine.passCompletions}/${qbLine.passAttempts}, ${qbLine.passYards} yds, ${qbLine.passTDs} TD, ${qbLine.interceptions} INT (${rating.toFixed(1)} rating)`,
      improvementTip:
        'The QB didn\'t play well enough to win - better decision-making/accuracy at the position, or an upgrade under center, would fix this.',
    })
  }

  // Explosive-play battle - who created chunk yardage and who gave it up.
  // No real play-by-play log exists yet to count actual 20+ yard gains, so
  // this uses yards-per-play (offense created vs offense allowed) as the
  // closest real signal the box score can speak to.
  const myOffense = sumOffense(myStats)
  const oppOffense = sumOffense(oppStats)
  const myYardsPerPlay = myOffense.yards / Math.max(1, myOffense.plays)
  const oppYardsPerPlay = oppOffense.yards / Math.max(1, oppOffense.plays)
  keys.push({
    label: 'Create Explosive Plays',
    succeeded: myYardsPerPlay >= 5.5,
    detail: `${myYardsPerPlay.toFixed(1)} yds/play on offense`,
    improvementTip: 'The offense isn\'t creating chunk yardage - look for a burner at WR or a home-run threat at RB.',
  })
  keys.push({
    label: 'Limit Explosive Plays',
    succeeded: oppYardsPerPlay <= 5.5,
    detail: `${oppYardsPerPlay.toFixed(1)} yds/play allowed on defense`,
    improvementTip: 'The defense keeps giving up chunk yardage - look for more team speed at linebacker, safety, or corner.',
  })

  keys.push({
    label: 'Establish the Run',
    succeeded: myRushing.yards >= 90 && myYpc >= 4.0,
    detail: `${myRushing.yards} yds on ${myRushing.attempts} carries (${myYpc.toFixed(1)} ypc)`,
    improvementTip: 'The ground game didn\'t move the needle - look for offensive line help or a more explosive back.',
  })

  keys.push({
    label: 'Protect the Quarterback',
    succeeded: mine.sacksAllowed <= 2,
    detail: `${mine.sacksAllowed} sack(s) allowed`,
    improvementTip: 'Pass protection is a real weakness - target an upgrade on the offensive line.',
  })

  const turnoverMargin = mine.turnoversForced - mine.turnoversCommitted
  keys.push({
    label: 'Win the Turnover Battle',
    succeeded: turnoverMargin >= 0,
    detail:
      turnoverMargin >= 0
        ? `+${turnoverMargin} margin (${mine.turnoversForced} forced, ${mine.turnoversCommitted} given up)`
        : `${turnoverMargin} margin (${mine.turnoversForced} forced, ${mine.turnoversCommitted} given up)`,
    improvementTip: 'Ball security and takeaways swung this one - a more careful QB or a playmaking secondary would help.',
  })

  keys.push({
    label: 'Pressure Their Quarterback',
    succeeded: mine.sacksMade >= 2,
    detail: `${mine.sacksMade} sack(s) made`,
    improvementTip: 'The pass rush didn\'t get home enough - look for an edge rusher or a blitzing linebacker.',
  })

  keys.push({
    label: 'Defend the Pass',
    succeeded: mine.passYardsAllowed <= 225,
    detail: `${mine.passYardsAllowed} yds allowed through the air`,
    improvementTip: 'The secondary got exposed - upgrade at cornerback or safety.',
  })

  keys.push({
    label: 'Defend the Run',
    succeeded: oppRushing.yards <= 100,
    detail: `${oppRushing.yards} yds allowed on the ground`,
    improvementTip: 'Too easy to run on - look for a stouter defensive line or a run-stopping linebacker.',
  })

  const kickAttempts = myStats.reduce((s, r) => s + r.fieldGoalsAttempted + r.extraPointsAttempted, 0)
  if (kickAttempts > 0) {
    keys.push({
      label: 'Win the Kicking Game',
      succeeded: mine.fieldGoalsMissed === 0,
      detail: mine.fieldGoalsMissed === 0 ? 'Perfect on kicks' : `${mine.fieldGoalsMissed} missed kick(s)`,
      improvementTip: 'Missed kicks left points on the field - a more accurate kicker would help close out games like this.',
    })
  }

  const succeededCount = keys.filter((k) => k.succeeded).length
  const grade = Math.max(1, Math.min(10, Math.round((succeededCount / keys.length) * 10)))

  return { grade, keys }
}

export interface TeamRecord {
  wins: number
  losses: number
  ties: number
}

function winPct(r: TeamRecord): number {
  const games = r.wins + r.losses + r.ties
  return games > 0 ? (r.wins + r.ties * 0.5) / games : 0.5
}

function recordLabel(r: TeamRecord): string {
  return `${r.wins}-${r.losses}${r.ties > 0 ? `-${r.ties}` : ''}`
}

export interface RecapPlayer extends HeadlinePlayer {
  /** This game's league-wide letter grade, if there were enough position peers that week to grade it. */
  grade?: SeasonGrade
}

/**
 * A local-beat-reporter recap of this exact game, not just a stat line -
 * how the result reads against expectations. A heavy favorite losing to a
 * bottom-feeder gets called a letdown by name, a huge underdog winning gets
 * treated as a real story, and an ordinary result still gets real
 * paragraphs on the quarterback, the defense, and whichever starter had a
 * game to forget. Unlike buildGameHeadlines (which only fires on standout
 * games), this always returns at least one paragraph - it runs every week.
 */
export function buildGameRecap(
  players: RecapPlayer[],
  myStats: PlayerGameStats[],
  oppStats: PlayerGameStats[],
  won: boolean,
  tied: boolean,
  myScore: number,
  oppScore: number,
  teamName: string,
  oppTeamName: string,
  myRecordEntering: TeamRecord,
  oppRecordEntering: TeamRecord,
): string[] {
  const margin = Math.abs(myScore - oppScore)
  const myPct = winPct(myRecordEntering)
  const oppPct = winPct(oppRecordEntering)
  const gap = myPct - oppPct
  const myGamesEntering = myRecordEntering.wins + myRecordEntering.losses + myRecordEntering.ties
  const oppGamesEntering = oppRecordEntering.wins + oppRecordEntering.losses + oppRecordEntering.ties
  // Don't read anything into a "gap" from a handful of early-season games -
  // a 2-1 team beating a 0-3 team isn't a real upset storyline yet.
  const enoughSample = myGamesEntering >= 4 && oppGamesEntering >= 4

  const paragraphs: string[] = []

  if (tied) {
    paragraphs.push(
      `${teamName} and ${oppTeamName} played to a ${myScore}-${oppScore} stalemate - not the decisive answer either sideline wanted heading into next week.`,
    )
  } else if (!won && enoughSample && gap >= 0.35) {
    paragraphs.push(
      `Wow. This team really went under expectations against ${oppTeamName} - ${teamName} came in ${recordLabel(myRecordEntering)} against a ${recordLabel(oppRecordEntering)} outfit and still walked away with a ${myScore}-${oppScore} loss. That is exactly the kind of game a team with real ambitions cannot drop.`,
    )
  } else if (won && enoughSample && gap <= -0.35) {
    paragraphs.push(
      `Somebody didn't get the memo. A ${recordLabel(myRecordEntering)} ${teamName} team went out and knocked off a ${recordLabel(oppRecordEntering)} ${oppTeamName} squad, ${myScore}-${oppScore} - the kind of result that should turn heads around the league.`,
    )
  } else if (won && margin >= 21) {
    paragraphs.push(`${teamName} left no doubt, handling ${oppTeamName} ${myScore}-${oppScore} from start to finish.`)
  } else if (won && margin <= 6 && enoughSample && gap >= 0.35) {
    paragraphs.push(
      `${teamName} survived ${oppTeamName} ${myScore}-${oppScore} - a win is a win, but it was closer than it had any business being. This team should never want a game that close against a ${recordLabel(oppRecordEntering)} opponent.`,
    )
  } else if (won && margin <= 6) {
    paragraphs.push(`${teamName} needed every bit of it, escaping ${oppTeamName} ${myScore}-${oppScore}.`)
  } else if (won) {
    paragraphs.push(`${teamName} got the job done against ${oppTeamName}, ${myScore}-${oppScore}.`)
  } else if (margin >= 21) {
    paragraphs.push(`A rough one all around - ${teamName} never found an answer in a ${myScore}-${oppScore} loss to ${oppTeamName}.`)
  } else {
    paragraphs.push(`${teamName} came up just short against ${oppTeamName}, ${myScore}-${oppScore}.`)
  }

  const qb = players.find((p) => p.position === 'QB' && p.stat.passAttempts >= 5)
  if (qb) {
    const rating = passerRating(
      qb.stat.passAttempts,
      qb.stat.passCompletions,
      qb.stat.passYards,
      qb.stat.passTDs,
      qb.stat.interceptions,
    )
    const qbName = `${qb.firstName} ${qb.lastName}`
    const line = `${qb.stat.passCompletions}/${qb.stat.passAttempts}, ${qb.stat.passYards} yds, ${qb.stat.passTDs} TD, ${qb.stat.interceptions} INT`
    if (rating >= 110) {
      paragraphs.push(`${qbName} was outstanding under center - ${line} (${rating.toFixed(1)} rating).`)
    } else if (rating >= 90) {
      paragraphs.push(`${qbName} did his job at quarterback - ${line}.`)
    } else if (rating >= 70) {
      paragraphs.push(
        `${qbName} was up and down - ${line} (${rating.toFixed(1)} rating) - nothing that beat the offense on its own, but nothing to build a game plan around either.`,
      )
    } else {
      paragraphs.push(`${qbName} played well below standard - ${line} (${rating.toFixed(1)} rating). That's not winning football at the position.`)
    }
  }

  const passYardsAllowed = myStats.reduce((sum, s) => sum + s.yardsAllowed, 0)
  const oppRush = sumRushing(oppStats)
  if (passYardsAllowed >= 280 || oppRush.yards >= 150) {
    paragraphs.push(
      `The defense allowed anything and everything to get by - ${passYardsAllowed} yds through the air and ${oppRush.yards} on the ground for ${oppTeamName}. That has to get cleaned up.`,
    )
  } else if (passYardsAllowed <= 175 && oppRush.yards <= 80) {
    paragraphs.push(`The defense held up its end - ${oppTeamName} managed just ${passYardsAllowed} passing and ${oppRush.yards} rushing yards.`)
  }

  // A specific starter having an off night, called out by name - checked in
  // rough order of how visible the position is to a GM deciding who to fix.
  const offNightPriority: Position[] = ['QB', 'RB', 'WR', 'TE', 'CB', 'S', 'DL', 'LB', 'OL', 'K']
  let offNight: RecapPlayer | undefined
  for (const pos of offNightPriority) {
    offNight = players.find((p) => p.position === pos && p.grade === 'F')
    if (offNight) break
  }
  if (offNight) {
    paragraphs.push(
      `${offNight.firstName} ${offNight.lastName} really wasn't on his A game this week - the kind of performance the coaching staff will want cleaned up, or a spot worth re-evaluating at the position if it becomes a pattern.`,
    )
  }

  return paragraphs
}
