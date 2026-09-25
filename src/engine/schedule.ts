export interface ScheduledGame {
  week: number
  homeTeamId: number
  awayTeamId: number
}

/** Simple round-robin schedule: every team plays every other team once per half. */
export function generateSchedule(teamIds: number[]): ScheduledGame[] {
  const games: ScheduledGame[] = []
  const n = teamIds.length
  const rounds = n - 1
  const teams = [...teamIds]
  if (n % 2 !== 0) teams.push(-1) // bye marker

  const half = teams.length / 2
  let week = 1
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const home = teams[i]
      const away = teams[teams.length - 1 - i]
      if (home !== -1 && away !== -1) {
        games.push(
          r % 2 === 0
            ? { week, homeTeamId: home, awayTeamId: away }
            : { week, homeTeamId: away, awayTeamId: home },
        )
      }
    }
    // rotate, keeping first team fixed
    teams.splice(1, 0, teams.pop()!)
    week++
  }
  return games
}
