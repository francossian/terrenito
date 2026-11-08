// Small geographic helpers: point-in-polygon lookups and great-circle distance

const insideRing = (x, y, ring) => {
  let inside = false
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a]
    const [xb, yb] = ring[b]
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
  }
  return inside
}

const insidePolygon = (x, y, rings) => insideRing(x, y, rings[0]) && !rings.slice(1).some((r) => insideRing(x, y, r))

const bbox = (geometry) => {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const p of polys) for (const [x, y] of p[0] ?? []) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
  }
  return [w, s, e, n]
}

// Index a FeatureCollection once; returns the first feature containing a point
export function featureFinder(collection) {
  const hasRings = (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
    (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat()).length > 0
  const items = collection.features.filter(hasRings).map((f) => ({ f, box: bbox(f.geometry) }))
  return (lon, lat) => {
    for (const { f, box } of items) {
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      if (polys.some((rings) => insidePolygon(lon, lat, rings))) return f
    }
    return null
  }
}

export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a))
}

// The world with Argentina cut out, to dim everything that is not shared out
export function outsideMask(argentina) {
  const holes = argentina.features.flatMap((f) =>
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]))
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...holes] } }
}
