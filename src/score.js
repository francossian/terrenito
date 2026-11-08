// Score of a parcel, 0 to 100, from the prepared layers only (water, climate, services,
// neighbours, the sea). Land cover is left out on purpose: it is read live from the imagery,
// and the score has to be computed the same way for the sample that ranks every parcel
// (scripts/score_sample.mjs).

// Points for the first threshold the value is under
const steps = (x, table) => {
  if (x == null) return 0
  for (const [limit, pts] of table) if (x < limit) return pts
  return 0
}

export const SCORE_PARTS = [
  ['agua', 'Agua dulce', 20],
  ['clima', 'Clima', 25],
  ['servicios', 'Servicios', 30],
  ['vecinos', 'Vecinos', 15],
  ['mar', 'Mar', 10],
]

export function scoreOf(t) {
  const rain = t.climate?.rain, temp = t.climate?.temp
  const parts = {
    agua: steps(t.fresh?.km, [[1, 20], [3, 15], [10, 8], [25, 3]]),
    clima: rain == null ? 0
      : steps(-Math.min(rain, 1600), [[-700, 15], [-500, 12], [-300, 8], [-150, 4]]) - (rain > 1600 ? 3 : 0) +
        (temp >= 12 && temp <= 20 ? 10 : temp >= 9 && temp <= 23 ? 8 : temp >= 6 ? 5 : temp >= 3 ? 2 : 0),
    servicios: steps(t.hospital?.km, [[5, 10], [15, 7], [40, 4], [80, 1]]) +
      steps(t.town?.km, [[3, 7], [10, 5], [30, 2]]) +
      steps(t.route?.km, [[3, 6], [10, 4], [30, 1]]) +
      steps(t.school?.km, [[3, 4], [10, 2]]) +
      steps(t.airport?.km, [[50, 3], [150, 1]]),
    vecinos: t.people10 >= 5000 ? 15 : t.people10 >= 500 ? 12 : t.people10 >= 50 ? 8 : t.people10 >= 5 ? 4 : 0,
    mar: steps(t.sea?.km, [[10, 10], [50, 6], [150, 3]]),
  }
  const total = Math.round(Object.values(parts).reduce((a, b) => a + b, 0))
  return { total, parts }
}

// Where a score sits among all parcels, from the sample's counts per score (0..100)
export function rankOf(total, dist) {
  if (!dist) return null
  let below = 0
  for (let s = 0; s < total; s++) below += dist.counts[s] ?? 0
  const better = (below + 0.5 * (dist.counts[total] ?? 0)) / dist.n     // share of parcels this one beats
  return { better, top: Math.max(1, Math.ceil(100 * (1 - better))) }
}

export const rankText = (r) => (r.top <= 50 ? `Top ${r.top}%` : `Mejor que el ${Math.round(100 * r.better)}%`)
