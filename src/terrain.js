// "Tu terreno": what a parcel is like and what is near it.
// Distances come from reference layers written by prep_stats.R; elevation and land cover are
// read live from the same tiles the map shows (AWS Terrain Tiles, EOX Sentinel-2 cloudless),
// so the card can never contradict the imagery.

import { featureFinder, distanceKm } from './geo.js'
import { scoreOf, rankOf } from './score.js'

const DATA = './data/stats/'
const LAYERS = ['hospitals', 'schools', 'airports', 'towns', 'routes', 'fresh', 'coast', 'people', 'climate']

// ---- Reference layers ------------------------------------------------------------------

// Undo the delta encoding: flat arrays of lon, lat (degrees), plus labels and extras
export function decode(o) {
  const lon = new Float64Array(o.n), lat = new Float64Array(o.n)
  let x = 0, y = 0
  for (let i = 0; i < o.n; i++) {
    x += o.dlon[i]; y += o.dlat[i]
    lon[i] = x / o.q; lat[i] = y / o.q
  }
  return { lon, lat, label: o.label, labels: o.labels, extra: o.extra, n: o.n }
}

let ready = null
export function loadTerrain() {
  ready ??= Promise.all([
    ...LAYERS.map((l) => fetch(`${DATA}${l}.json`).then((r) => r.json())),
    fetch(`${DATA}ecoregions.geojson`).then((r) => r.json()),
    fetch(`${DATA}score.json`).then((r) => r.json()).catch(() => null),
  ]).then((parts) => {
    const L = {}
    LAYERS.forEach((name, i) => { L[name] = name === 'climate' ? parts[i] : decode(parts[i]) })
    L.ecoregion = featureFinder(parts[LAYERS.length])
    L.scoreDist = parts[LAYERS.length + 1]
    return L
  })
  return ready
}

// Nearest point, by an equirectangular screen then the exact great-circle distance
export function nearest(layer, lon, lat, filter = null) {
  const k = Math.cos((lat * Math.PI) / 180)
  let best = -1, bestD = Infinity
  for (let i = 0; i < layer.n; i++) {
    if (filter && !filter(i)) continue
    const dx = (layer.lon[i] - lon) * k, dy = layer.lat[i] - lat
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = i }
  }
  if (best < 0) return null
  return {
    km: distanceKm([lon, lat], [layer.lon[best], layer.lat[best]]),
    name: layer.labels ? layer.labels[layer.label[best]] : null,
    extra: layer.extra ? layer.extra[best] : null,
  }
}

// People living within r km (WorldPop 1 km cells)
export function peopleWithin(layer, lon, lat, r) {
  const dLat = r / 111.2, dLon = dLat / Math.cos((lat * Math.PI) / 180)
  let sum = 0
  for (let i = 0; i < layer.n; i++) {
    if (Math.abs(layer.lat[i] - lat) > dLat || Math.abs(layer.lon[i] - lon) > dLon) continue
    if (distanceKm([lon, lat], [layer.lon[i], layer.lat[i]]) <= r) sum += layer.extra[i]
  }
  return sum
}

export function climateAt(c, lon, lat) {
  const col = Math.floor((lon - c.x0) / c.dx), row = Math.floor((c.y0 - lat) / c.dy)
  if (col < 0 || row < 0 || col >= c.nx || row >= c.ny) return null
  const i = row * c.nx + col
  const t = c.temp10[i], r = c.rain[i]
  return t == null || r == null ? null : { temp: t / 10, rain: r }
}

// Hours of daylight at the June solstice (the southern winter), from latitude alone
function winterDaylight(lat) {
  const phi = (lat * Math.PI) / 180, decl = (23.44 * Math.PI) / 180
  const x = -Math.tan(phi) * Math.tan(decl)
  return x >= 1 ? 0 : x <= -1 ? 24 : (24 / Math.PI) * Math.acos(x)
}

// ---- Live tile reads -------------------------------------------------------------------

const tileXY = (lon, lat, z) => {
  const n = 2 ** z
  return [((lon + 180) / 360) * n,
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n]
}

// Every pixel of a lon/lat box at zoom z, across as many tiles as it spans
async function pixels(cell, z, url) {
  const [x0, y0] = tileXY(cell.w, cell.n, z)
  const [x1, y1] = tileXY(cell.e, cell.s, z)
  const out = []
  for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++) {
    for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
      const blob = await fetch(url(z, tx, ty)).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const cv = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = cv.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0)
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
      const px0 = Math.max(0, Math.floor((x0 - tx) * 256)), px1 = Math.min(255, Math.floor((x1 - tx) * 256))
      const py0 = Math.max(0, Math.floor((y0 - ty) * 256)), py1 = Math.min(255, Math.floor((y1 - ty) * 256))
      for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
        const k = (py * 256 + px) * 4
        out.push([data[k], data[k + 1], data[k + 2]])
      }
    }
  }
  return out
}

// Elevation from Terrarium tiles: height = R·256 + G + B/256 − 32768
async function elevation(cell) {
  const px = await pixels(cell, 13, (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`)
  const h = px.map(([r, g, b]) => r * 256 + g + b / 256 - 32768)
  const mean = h.reduce((a, b) => a + b, 0) / h.length
  return { mean, relief: Math.max(...h) - Math.min(...h) }
}

// What the imagery shows, from pixel colours (thresholds calibrated on known places)
async function landCover(cell) {
  const px = await pixels(cell, 14, (z, x, y) =>
    `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`)
  const share = { vegDense: 0, vegSparse: 0, bare: 0, water: 0, snow: 0 }
  for (const [R8, G8, B8] of px) {
    const r = R8 / 255, g = G8 / 255, b = B8 / 255
    const s = r + g + b + 1e-6
    const bri = s / 3
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / (Math.max(r, g, b) + 1e-6)
    const blue = (b - r) / s
    const exg = (2 * g - r - b) / s
    if (bri < 0.045 || (blue > 0.01 && bri < 0.2)) share.water++
    else if (bri > 0.3 && sat < 0.18 && blue > -0.03) share.snow++
    else if (exg >= 0.25) share.vegDense++
    else if (exg >= 0.07) share.vegSparse++
    else share.bare++
  }
  for (const k in share) share[k] = share[k] / px.length
  return share
}

// ---- The card ------------------------------------------------------------------------

export const inMalvinas = (lon, lat) => lat < -50.8 && lat > -52.6 && lon > -61.6 && lon < -57.5

// Everything that comes from the prepared layers: also used, unchanged, by the score sample
export function nearby(L, lon, lat) {
  return {
    climate: climateAt(L.climate, lon, lat),
    town: nearest(L.towns, lon, lat),
    hospital: nearest(L.hospitals, lon, lat),
    school: nearest(L.schools, lon, lat),
    route: nearest(L.routes, lon, lat),
    airport: nearest(L.airports, lon, lat),
    sea: nearest(L.coast, lon, lat),
    fresh: nearest(L.fresh, lon, lat),
    people10: peopleWithin(L.people, lon, lat, 10),
  }
}

// Score of any parcel without reading tiles: fast enough to compare two parcels on the spot
export async function quickScore(cell) {
  const L = await loadTerrain()
  const lon = (cell.w + cell.e) / 2, lat = (cell.n + cell.s) / 2
  const t = nearby(L, lon, lat)
  const score = scoreOf(t)
  return { number: cell.number, total: score.total, rank: rankOf(score.total, L.scoreDist), town: t.town?.name ?? null }
}

export async function describe(cell, obelisco) {
  const L = await loadTerrain()
  const lon = (cell.w + cell.e) / 2, lat = (cell.n + cell.s) / 2
  const [elev, cover] = await Promise.all([
    elevation(cell).catch(() => null),
    landCover(cell).catch(() => null),
  ])

  const t = {
    lon, lat, elev, cover,
    ...nearby(L, lon, lat),
    daylight: winterDaylight(lat),
    malvinas: inMalvinas(lon, lat),
    ecoregion: L.ecoregion(lon, lat)?.properties.name ?? (inMalvinas(lon, lat) ? 'Estepa de las Islas Malvinas' : null),
    city: nearest(L.towns, lon, lat, (i) => L.towns.extra[i] === 0),     // place=city
    people1: peopleWithin(L.people, lon, lat, 1),
    obelisco: distanceKm([lon, lat], obelisco),
  }
  t.score = scoreOf(t)
  t.rank = rankOf(t.score.total, L.scoreDist)
  // Bright roofs and salt flats look like snow: only count it high up or in the far south
  if (cover && !(t.elev?.mean > 1500 || lat < -50)) { cover.bare += cover.snow; cover.snow = 0 }
  t.urban = t.people1 > 1500                        // more than ~1,500 people per km² around: a town or city
  t.farm = farmVerdict(t)
  t.badges = badges(t)
  return t
}

// Could you live off it? Simple, visible rules: land you can work, water, climate
function farmVerdict(t) {
  const c = t.cover, k = t.climate
  if (!c || !k) return { level: 0, text: 'Sin datos suficientes para decirlo.' }
  const green = c.vegDense + c.vegSparse
  const flat = t.elev ? t.elev.relief < 60 : true
  const water = (t.fresh?.km ?? 99) < 5 || k.rain >= 700
  const river = t.fresh && t.fresh.km < 2 ? t.fresh : null
  if (t.urban) return { level: 1, text: 'Está dentro de un pueblo o una ciudad: da para una huerta en el patio, no para vivir del campo.' }
  if (c.snow > 0.4 || (t.elev && t.elev.mean > 3800)) return { level: 0, text: 'Demasiado alto o helado para cultivar.' }
  if (c.water > 0.5) return { level: 0, text: 'La mayor parte es agua.' }
  if (green >= 0.5 && flat && k.rain >= 600 && k.temp >= 8 && water) {
    return c.vegDense > 0.6
      ? { level: 3, text: 'Sí: llueve, es plano y el clima acompaña. Es monte cerrado: habría que abrir un claro para la huerta.' }
      : { level: 3, text: 'Sí: hay vegetación, es plano, llueve y el clima acompaña. Da para huerta y animales.' }
  }
  if (river && flat && k.rain < 600 && k.temp >= 8)
    return { level: 2, text: `Con riego: llueve poco, pero ${river.name} está a ${river.km < 1 ? `${Math.round(river.km * 1000)} m` : `${river.km.toFixed(1).replace('.', ',')} km`}. Con canales, se puede cultivar.` }
  if (green >= 0.3 && k.rain >= 300)
    return { level: 2, text: 'Con esfuerzo: sirve para pastoreo o una huerta con riego, no mucho más.' }
  return { level: 1, text: 'Difícil: poca vegetación y poca lluvia. Te va a hacer falta agua de afuera.' }
}

function badges(t) {
  const out = []
  const c = t.cover
  if (t.malvinas) out.push(['🏝️', 'Isleño'])
  if (t.sea && t.sea.km < 5) out.push(['🌊', 'Vista al mar'])
  if (t.fresh && t.fresh.km < 1.5) out.push(['💧', 'Agua a mano'])
  if (t.people10 < 50) out.push(['🦉', 'Ermitaño'])
  if ((t.hospital?.km ?? 99) < 10 && (t.route?.km ?? 99) < 5 && (t.town?.km ?? 99) < 5) out.push(['🏥', 'Cerca de todo'])
  if (t.elev && t.elev.mean > 3000) out.push(['🏔️', 'Techo del país'])
  if (t.elev && t.elev.relief > 150) out.push(['⛰️', 'En la ladera'])
  if (t.farm.level === 3) out.push(['🌱', 'Tierra para cultivar'])
  if (c && c.vegDense > 0.6 && !t.urban) out.push(['🌳', 'Monte cerrado'])
  if (t.climate && t.climate.rain < 200 && c && c.vegDense + c.vegSparse < 0.2) out.push(['🏜️', 'Desierto'])
  if (t.climate && t.climate.temp < 6) out.push(['🧣', 'Abrigate'])
  if (t.urban) out.push(['🏘️', 'Vida de pueblo o ciudad'])
  if (t.daylight < 8) out.push(['🌙', 'Inviernos de noche larga'])
  return out
}
