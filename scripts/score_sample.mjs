// Ranks parcels: scores a random sample with the app's own code and writes how many parcels
// get each score, 0 to 100. With 20,000 parcels the "Top X%" is right to within ~1 point.
//   node scripts/score_sample.mjs [sample size]
import { readFileSync, writeFileSync } from 'fs'
import { buildGrid } from '../src/grid.js'
import { decode, nearby } from '../src/terrain.js'
import { scoreOf } from '../src/score.js'

const N = Number(process.argv[2] ?? 20000)
const DATA = new URL('../public/data/', import.meta.url)
const json = (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'))

const grid = json('grid.json')
const g = buildGrid(grid)
const L = {}
for (const name of ['hospitals', 'schools', 'airports', 'towns', 'routes', 'fresh', 'coast', 'people']) {
  L[name] = decode(json(`stats/${name}.json`))
}
L.climate = json('stats/climate.json')

// Seeded, so the ranking only changes when the data does
let seed = 20261108
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)

const counts = new Array(101).fill(0)
const t0 = Date.now()
for (let k = 0; k < N; k++) {
  const c = g.cellByNumber(1 + Math.floor(rand() * grid.population))
  const s = scoreOf(nearby(L, (c.w + c.e) / 2, (c.n + c.s) / 2)).total
  counts[s]++
  if ((k + 1) % 5000 === 0) console.log(`${k + 1} parcels · ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

const median = (() => { let acc = 0; for (let s = 0; s <= 100; s++) { acc += counts[s]; if (acc >= N / 2) return s } })()
writeFileSync(new URL('stats/score.json', DATA), JSON.stringify({ n: N, counts }))
console.log(`median score ${median} · min ${counts.findIndex((x) => x > 0)} · max ${100 - [...counts].reverse().findIndex((x) => x > 0)}`)
