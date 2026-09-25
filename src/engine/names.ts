import type { Rng } from './rng'
import { randInt } from './rng'

const FIRST_NAMES = [
  'James', 'Michael', 'David', 'Chris', 'Marcus', 'Jordan', 'Tyler', 'Brandon',
  'Justin', 'Andre', 'DeShawn', 'Malik', 'Ethan', 'Cole', 'Dante', 'Trevor',
  'Xavier', 'Isaiah', 'Cameron', 'Jalen',
]

const LAST_NAMES = [
  'Johnson', 'Williams', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore',
  'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin',
  'Thompson', 'Robinson', 'Walker', 'Young', 'Allen', 'King',
]

export function randomName(rng: Rng) {
  return {
    firstName: FIRST_NAMES[randInt(rng, 0, FIRST_NAMES.length - 1)],
    lastName: LAST_NAMES[randInt(rng, 0, LAST_NAMES.length - 1)],
  }
}
