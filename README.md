# Dynasty

A browser-based football GM/dynasty simulator, inspired by football-gm.com.

## Stack

- React + TypeScript + Vite
- Tailwind CSS v4
- Dexie (IndexedDB) for local, serverless league saves
- Deterministic seeded RNG sim engine (`src/engine`)

## Getting started

```sh
npm install
npm run dev
```

## Project layout

- `src/types` — domain models (Player, Team, League, GameResult, ...)
- `src/db` — Dexie database schema
- `src/engine` — league generation, roster generation, schedule generation,
  and the game simulator. Framework-agnostic, no React or DB imports except
  in `league.ts`, which wires the engine to persistence.
- `src/App.tsx` — minimal UI: create a league, view teams, sim a week, see
  results.

## Status

Early scaffold. Current loop: generate an 8-team league with full rosters,
generate a round-robin schedule, sim week-by-week with a box-score-level
game model (no play-by-play yet).

## Roadmap

1. Play-by-play or drive-level game simulation
2. Standings / playoffs
3. Draft (rookie generation + draft day flow)
4. Free agency, contracts, and salary cap logic
5. Player progression/regression by age and potential
6. Trades
7. Save/load multiple leagues, export/import
8. Stats and history pages
