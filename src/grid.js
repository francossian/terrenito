// The parcel grid, rebuilt from grid.json (written by prep_parcels.R).
//
// Bands of constant latitude height run from the northern tip southwards. In band i the
// columns are as wide as needed for every cell to have exactly the same area on the sphere:
//   area = R² · Δλᵢ · (sin φ_top − sin φ_bottom)
// For each band the file lists the runs of columns whose centre lies on land that can be
// shared out. Parcels are numbered 1..N north to south, then west to east.

const DEG = 180 / Math.PI

export function buildGrid(data) {
  const { radius_m: R, area_m2: A, dphi_rad: dphi, lon0 } = data
  const latTop = data.lat_top / DEG
  const nBands = Math.max(...data.band) + 1

  // Dense per-band lookup: runs and the number of the band's first parcel
  const bands = new Array(nBands).fill(null)
  let first = 1
  data.band.forEach((b, k) => {
    bands[b] = { runs: data.runs[k], first, count: data.count[k] }
    first += data.count[k]
  })
  const bandOrder = data.band          // non-empty bands, north to south
  const bandFirst = bandOrder.map((b) => bands[b].first)

  const top = (i) => latTop - i * dphi
  const dlamDeg = (i) => (A / (R * R * (Math.sin(top(i)) - Math.sin(top(i) - dphi)))) * DEG

  const bounds = (i, j) => {
    const w = lon0 + j * dlamDeg(i)
    return { w, e: w + dlamDeg(i), n: top(i) * DEG, s: (top(i) - dphi) * DEG }
  }

  // Parcel number of column j in band i, or null when that cell is not shared out
  const numberOf = (i, j) => {
    const band = bands[i]
    if (!band) return null
    let offset = 0
    for (let k = 0; k < band.runs.length; k += 2) {
      const [c0, c1] = [band.runs[k], band.runs[k + 1]]
      if (j < c0) return null
      if (j <= c1) return band.first + offset + (j - c0)
      offset += c1 - c0 + 1
    }
    return null
  }

  const cellAt = (lon, lat) => {
    const i = Math.floor((latTop - lat / DEG) / dphi)
    if (i < 0 || i >= nBands) return null
    const j = Math.floor((lon - lon0) / dlamDeg(i))
    const number = numberOf(i, j)
    return { i, j, number, ...bounds(i, j) }
  }

  const cellByNumber = (number) => {
    if (number < 1 || number > data.parcels) return null
    let lo = 0, hi = bandOrder.length - 1           // last band whose first parcel <= number
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bandFirst[mid] <= number) lo = mid
      else hi = mid - 1
    }
    const i = bandOrder[lo]
    let rest = number - bands[i].first
    const runs = bands[i].runs
    for (let k = 0; k < runs.length; k += 2) {
      const len = runs[k + 1] - runs[k] + 1
      if (rest < len) {
        const j = runs[k] + rest
        return { i, j, number, ...bounds(i, j) }
      }
      rest -= len
    }
    return null
  }

  // Outlines of the parcels inside a view, as GeoJSON lines. null when there are too many
  const linesIn = ({ west, east, south, north }, maxCells = 40000) => {
    const iFrom = Math.max(0, Math.floor((latTop - north / DEG) / dphi))
    const iTo = Math.min(nBands - 1, Math.floor((latTop - south / DEG) / dphi))
    const coords = []
    let cells = 0
    for (let i = iFrom; i <= iTo; i++) {
      const band = bands[i]
      if (!band) continue
      const d = dlamDeg(i)
      const n = top(i) * DEG
      const s = (top(i) - dphi) * DEG
      const jw = Math.floor((west - lon0) / d)
      const je = Math.floor((east - lon0) / d)
      for (let k = 0; k < band.runs.length; k += 2) {
        const c0 = Math.max(band.runs[k], jw)
        const c1 = Math.min(band.runs[k + 1], je)
        if (c1 < c0) continue
        cells += c1 - c0 + 1
        if (cells > maxCells) return null
        const w = lon0 + c0 * d
        const e = lon0 + (c1 + 1) * d
        coords.push([[w, n], [e, n]], [[w, s], [e, s]])
        for (let j = c0; j <= c1 + 1; j++) {
          const x = lon0 + j * d
          coords.push([[x, n], [x, s]])
        }
      }
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: coords } }
  }

  // Neighbouring parcels, when they are shared out too
  const neighbours = (cell) => {
    const mid = (cell.w + cell.e) / 2
    const cy = (cell.n + cell.s) / 2
    const h = cell.n - cell.s
    return {
      north: cellAt(mid, cy + h)?.number ?? null,
      south: cellAt(mid, cy - h)?.number ?? null,
      west: numberOf(cell.i, cell.j - 1),
      east: numberOf(cell.i, cell.j + 1),
    }
  }

  return { cellAt, cellByNumber, linesIn, neighbours, parcels: data.parcels }
}

// Polygon of a cell, for highlighting
export const cellPolygon = (c) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[c.w, c.n], [c.e, c.n], [c.e, c.s], [c.w, c.s], [c.w, c.n]]] },
})
