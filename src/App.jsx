import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import { buildGrid, cellPolygon } from './grid.js'
import { featureFinder, distanceKm, outsideMask } from './geo.js'
import { describe, loadTerrain } from './terrain.js'
import { SCORE_PARTS, rankText } from './score.js'
import { shareImage, shareText } from './share.js'

const DATA = './data/'
const GRID_MIN_ZOOM = 12            // below this the parcels are a few pixels wide
const OBELISCO = [-58.3816, -34.6037]
const EMPTY = { type: 'FeatureCollection', features: [] }

// Who owns their home today: INDEC, Censo 2022, Condiciones habitacionales (households in their own home)
const OWN_HOME = { total: 65.5, caba: 52.9 }

const fmt = (n, d = 0) => n.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d })

const style = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',   // Noto Sans Regular, Open Sans Semibold
  sources: {
    imagery: {
      type: 'raster',
      tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
      tileSize: 256,
      maxzoom: 16,
      attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2020</a> de EOX IT Services GmbH (contiene datos modificados de Copernicus Sentinel 2020), CC BY-NC-SA 4.0',
    },
  },
  layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }],
}

// Place names, in Spanish and drawn above every fill. Lakes appear sooner the bigger they are
const halo = { 'text-halo-color': 'rgba(10, 14, 18, 0.85)', 'text-halo-width': 1.4 }
const LABEL_LAYERS = [
  { id: 'lbl-provincia', source: 'labels', filter: ['==', ['get', 'kind'], 'provincia'], maxzoom: 7.5,
    layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5,
      'text-letter-spacing': 0.12, 'text-max-width': 8 },
    paint: { 'text-color': 'rgba(255, 255, 255, 0.75)', ...halo } },
  { id: 'lbl-islas', source: 'labels', filter: ['==', ['get', 'kind'], 'islas'], maxzoom: 10,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 14, 'text-letter-spacing': 0.08 },
    paint: { 'text-color': '#ffffff', ...halo } },
  ...[[6, 300], [8, 40], [9.5, 0]].map(([minzoom, km2], k, all) => ({
    id: `lbl-lago-${k}`, source: 'labels', minzoom,
    filter: ['all', ['==', ['get', 'kind'], 'lago'], ['>=', ['get', 'km2'], km2],
      ...(k > 0 ? [['<', ['get', 'km2'], all[k - 1][1]]] : [])],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-max-width': 7 },
    paint: { 'text-color': '#cfe3ff', ...halo },
  })),
  ...[[0, 5, 13, 'Open Sans Semibold'], [1, 8, 12, 'Noto Sans Regular'], [2, 10.5, 11, 'Noto Sans Regular']]
    .map(([cls, minzoom, size, font]) => ({
      id: `lbl-pueblo-${cls}`, source: 'towns', minzoom, filter: ['==', ['get', 'cls'], cls],
      layout: { 'text-field': ['get', 'name'], 'text-font': [font], 'text-size': size, 'text-max-width': 8 },
      paint: { 'text-color': '#ffffff', ...halo },
    })),
]

// Towns layer of the card, as GeoJSON points for the labels
const townsGeoJSON = (o) => {
  const features = []
  let x = 0, y = 0
  for (let i = 0; i < o.n; i++) {
    x += o.dlon[i]; y += o.dlat[i]
    features.push({ type: 'Feature', properties: { name: o.labels[o.label[i]], cls: o.extra[i] },
      geometry: { type: 'Point', coordinates: [x / o.q, y / o.q] } })
  }
  return { type: 'FeatureCollection', features }
}

// What each kind of held-back land is, for the card
const WHY = {
  'Parque o reserva nacional': 'Es tierra del Estado nacional y se conserva para todos.',
  'Parque provincial o municipal': 'Es tierra pública protegida por la provincia o el municipio.',
  'Reserva natural estricta': 'Es un área protegida donde no se puede habitar.',
  'Zona militar': 'Es tierra de las Fuerzas Armadas.',
  'Lago, río o laguna': 'Es agua: nadie puede vivir acá.',
  'Glaciar': 'Es hielo: nadie puede vivir acá.',
  'Plaza o parque urbano': 'Es un espacio público de la ciudad y sigue siendo de todos.',
}

export default function App() {
  const mapDiv = useRef(null)
  const map = useRef(null)
  const lookups = useRef(null)
  const [meta, setMeta] = useState(null)
  const [zoom, setZoom] = useState(4)
  const [picked, setPicked] = useState(null)
  const [query, setQuery] = useState('')
  const [labels, setLabels] = useState(true)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 720)

  // ---- Selecting a place: a parcel, held land, or outside Argentina --------------
  const select = useCallback((lon, lat, { fly = false } = {}) => {
    const L = lookups.current
    if (!L) return
    const cell = L.grid.cellAt(lon, lat)
    let info
    if (cell?.number) {
      const cx = (cell.w + cell.e) / 2
      const cy = (cell.n + cell.s) / 2
      info = {
        kind: 'parcel',
        cell,
        province: L.province(cx, cy)?.properties.name ?? '—',
        centre: [cx, cy],
        km: distanceKm([cx, cy], OBELISCO),
        neighbours: L.grid.neighbours(cell),
      }
    } else {
      const held = L.held(lon, lat) ?? L.parks(lon, lat) ?? L.nature(lon, lat)
      info = held ? { kind: 'held', name: held.properties.name, what: held.properties.kind }
        : L.country(lon, lat) ? { kind: 'edge' } : { kind: 'outside' }
    }
    setPicked(info)
    if (info.kind === 'parcel') {
      describe(info.cell, OBELISCO)
        .then((terrain) => setPicked((p) => (p?.cell?.number === info.cell.number ? { ...p, terrain } : p)))
        .catch(() => setPicked((p) => (p?.cell?.number === info.cell.number ? { ...p, terrain: 'error' } : p)))
    }
    if (window.innerWidth <= 720) setPanelOpen(false)            // phones: the card replaces the panel
    map.current.getSource('picked').setData(info.kind === 'parcel' ? cellPolygon(info.cell) : EMPTY)
    if (info.kind === 'parcel') {
      history.replaceState(null, '', `#parcela=${info.cell.number}`)
      if (fly) {
        map.current.fitBounds([[info.cell.w, info.cell.s], [info.cell.e, info.cell.n]],
          { padding: 120, maxZoom: 14.5, duration: 2500 })
      }
    }
  }, [])

  const goToNumber = useCallback((n) => {
    const cell = lookups.current?.grid.cellByNumber(n)
    if (cell) select((cell.w + cell.e) / 2, (cell.n + cell.s) / 2, { fly: true })
  }, [select])

  // ---- Map and data ------------------------------------------------------------------
  useEffect(() => {
    const m = new maplibregl.Map({
      container: mapDiv.current,
      style,
      bounds: [[-74, -55.2], [-53.5, -21.7]],   // the Malvinas fit in this box too
      fitBoundsOptions: { padding: { top: 40, bottom: 40, left: window.innerWidth > 720 ? 380 : 40, right: 40 } },
      maxZoom: 16.5,
      attributionControl: { compact: true },
      locale: { 'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar' },
    })
    map.current = m
    if (import.meta.env.DEV || location.hostname === 'localhost') window.__map = m   // for local checks
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    const load = (f) => fetch(DATA + f).then((r) => r.json())
    const ready = new Promise((ok) => m.on('load', ok))

    // Water, mountains and parks are the heavy layers: they load after the map is usable
    const none = () => null
    Promise.all([load('grid.json'), load('argentina.geojson'), load('held.geojson'), load('provinces.geojson'), ready])
      .then(([grid, argentina, held, provinces]) => {
        lookups.current = {
          meta: grid,
          grid: buildGrid(grid),
          held: featureFinder(held),
          nature: none,
          parks: none,
          province: featureFinder(provinces),
          country: featureFinder(argentina),
          argentina,
        }
        setMeta(grid)

        m.addSource('outside', { type: 'geojson', data: outsideMask(argentina) })
        m.addSource('held', { type: 'geojson', data: held })
        m.addSource('nature', { type: 'geojson', data: EMPTY })
        m.addSource('parks', { type: 'geojson', data: EMPTY })
        for (const [name, file] of [['nature', 'nature.geojson'], ['parks', 'parks.geojson']]) {
          load(file).then((fc) => {
            m.getSource(name).setData(fc)
            lookups.current[name] = featureFinder(fc)
          })
        }
        m.addSource('country', { type: 'geojson', data: argentina })
        m.addSource('parcels', { type: 'geojson', data: EMPTY })
        m.addSource('picked', { type: 'geojson', data: EMPTY })

        m.addLayer({ id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': '#0b0f14', 'fill-opacity': 0.55 } })
        m.addLayer({ id: 'nature-fill', type: 'fill', source: 'nature', paint: { 'fill-color': '#6aa8ff', 'fill-opacity': 0.3 } })
        m.addLayer({ id: 'nature-line', type: 'line', source: 'nature', paint: { 'line-color': '#a9cbff', 'line-width': 0.8, 'line-opacity': 0.7 } })
        m.addLayer({ id: 'held-fill', type: 'fill', source: 'held', paint: { 'fill-color': '#3fb8a5', 'fill-opacity': 0.28 } })
        m.addLayer({ id: 'held-line', type: 'line', source: 'held', paint: { 'line-color': '#7fe0d0', 'line-width': 1, 'line-opacity': 0.8 } })
        m.addLayer({ id: 'parks-fill', type: 'fill', source: 'parks', minzoom: 11, paint: { 'fill-color': '#3fb8a5', 'fill-opacity': 0.35 } })
        m.addLayer({ id: 'country', type: 'line', source: 'country', paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.85 } })
        m.addLayer({
          id: 'parcels', type: 'line', source: 'parcels',
          paint: { 'line-color': '#ffffff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 15, 0.7], 'line-width': 0.7 },
        })
        m.addLayer({ id: 'picked-fill', type: 'fill', source: 'picked', paint: { 'fill-color': '#ff8a3d', 'fill-opacity': 0.25 } })
        m.addLayer({ id: 'picked-line', type: 'line', source: 'picked', paint: { 'line-color': '#ff8a3d', 'line-width': 2.5 } })

        // Province borders and place names go on top of everything
        m.addSource('provinces', { type: 'geojson', data: provinces })
        m.addLayer({ id: 'province-lines', type: 'line', source: 'provinces',
          paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 1.4],
            'line-dasharray': [3, 2] } })
        m.addSource('labels', { type: 'geojson', data: DATA + 'labels.geojson' })
        m.addSource('towns', { type: 'geojson', data: EMPTY })
        load('stats/towns.json').then((o) => m.getSource('towns').setData(townsGeoJSON(o)))
        for (const l of LABEL_LAYERS) m.addLayer({ type: 'symbol', ...l })

        loadTerrain()                                            // warm up the card's reference layers
        const hash = location.hash.match(/parcela=(\d+)/)
        if (hash) goToNumber(Number(hash[1]))
      })

    const redraw = () => {
      setZoom(m.getZoom())
      const src = m.getSource('parcels')
      if (!src || !lookups.current) return
      if (m.getZoom() < GRID_MIN_ZOOM) return src.setData(EMPTY)
      const b = m.getBounds()
      const lines = lookups.current.grid.linesIn({ west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() })
      src.setData(lines ?? EMPTY)
    }
    m.on('moveend', redraw)
    m.on('load', redraw)
    m.on('click', (e) => select(e.lngLat.lng, e.lngLat.lat))
    m.on('mousemove', () => { m.getCanvas().style.cursor = m.getZoom() >= GRID_MIN_ZOOM ? 'crosshair' : '' })
    m.on('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'))

    return () => m.remove()
  }, [select, goToNumber])

  useEffect(() => {
    for (const l of LABEL_LAYERS) {
      if (map.current?.getLayer(l.id)) map.current.setLayoutProperty(l.id, 'visibility', labels ? 'visible' : 'none')
    }
  }, [labels])

  const random = () => meta && goToNumber(1 + Math.floor(Math.random() * meta.population))
  const search = (e) => {
    e.preventDefault()
    const n = Number(query.replace(/[^\d]/g, ''))
    if (n) goToNumber(n)
  }

  const ha = meta ? meta.area_m2 / 1e4 : 0
  const heldPct = meta ? 100 * (1 - meta.shared_km2 / meta.country_km2) : 0

  return (
    <div className="app">
      <div ref={mapDiv} className="map" />

      <aside className={`panel ${panelOpen ? '' : 'closed'}`}>
        <button className="toggle" onClick={() => setPanelOpen(!panelOpen)} aria-label="Mostrar u ocultar el panel">
          {panelOpen ? '–' : 'i'}
        </button>
        <p className="kicker">#30DayMapChallenge · Día 8 · Utopía</p>
        <h1>Argentina, repartida</h1>
        {meta && (
          <>
            <p className="lead">
              Si la tierra argentina se repartiera en partes iguales entre sus <b>{fmt(meta.population)}</b> habitantes,
              a cada persona le tocarían <b>{fmt(ha, 1)} hectáreas</b>: un cuadrado de unos <b>{fmt(meta.side_m)} m</b> de lado.
            </p>
            <p className="lead today">
              Hoy, <b>más de un tercio de los hogares no vive en una casa propia</b>. En la Ciudad de Buenos Aires,
              casi la mitad.<sup>*</sup>
            </p>
            <div className="actions">
              <button className="primary" onClick={random}>Dame mi terreno</button>
              <form onSubmit={search} className="search">
                <input inputMode="numeric" placeholder={`Parcela 1 a ${fmt(meta.parcels)}`}
                  value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Número de parcela" />
                <button type="submit">Ir</button>
              </form>
            </div>
            <ul className="legend">
              <li><span className="key parcel" />Una parcela por persona (acercate para verlas)</li>
              <li><span className="key held" />No se reparte: parques, reservas, plazas y zonas militares</li>
              <li><span className="key nature" />No se reparte: agua, glaciares y alta montaña</li>
              <li><span className="key pick" />Parcela elegida</li>
            </ul>
            <label className="check">
              <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Nombres de lugares
            </label>
            <details>
              <summary>Cómo funciona</summary>
              <p>
                Se reparte el territorio continental, Tierra del Fuego y las Islas Malvinas, menos lo que no es de nadie en particular o
                donde nadie puede vivir: parques y reservas nacionales, parques provinciales y municipales, reservas
                estrictas, zonas militares, plazas y parques urbanos, lagos y ríos, glaciares y las tierras por encima
                de los 4.500 m (el pueblo más alto del país, Olacapato, está a unos 4.100 m). En total, el {fmt(heldPct, 1)}% del país.
              </p>
              <p>
                Lo que queda se divide en {fmt(meta.parcels)} parcelas de exactamente {fmt(Math.round(meta.area_m2))} m²,
                numeradas de norte a sur. Sobran {fmt(meta.parcels - meta.population)} porque en los bordes solo se
                cuentan parcelas enteras.
              </p>
              <p>
                La ficha de cada terreno lee la altura y el desnivel de un modelo de elevación, y lo que hay
                (vegetación, suelo desnudo, agua, nieve) de los colores de la misma imagen satelital del mapa.
                Las distancias se miden en línea recta al punto más cercano. El veredicto sigue reglas simples:
                hace falta vegetación, terreno plano, lluvia o un río cerca, y un clima templado.
              </p>
              <p className="sources">
                Ficha: altura de Terrain Tiles (AWS); clima de WorldClim 2.1 (promedios 1970–2000); ecorregiones
                de RESOLVE Ecoregions 2017; población de WorldPop 2020; hospitales, escuelas, pueblos, aeropuertos,
                rutas, ríos y lagos de OpenStreetMap.
              </p>
              <p className="sources">
                * Hogares en vivienda propia: {fmt(OWN_HOME.total, 1)}% del país y {fmt(OWN_HOME.caba, 1)}% en la Ciudad
                (INDEC, Censo 2022, condiciones habitacionales). Población: INDEC, Censo 2022, resultados definitivos.
                Áreas protegidas, zonas militares, agua, glaciares y plazas: © colaboradores de OpenStreetMap.
                Altura: Terrain Tiles (AWS). País y provincias: Natural Earth. Imagen: Sentinel-2 cloudless 2020 de EOX.
              </p>
            </details>
          </>
        )}
        {!meta && <p className="lead">Midiendo el país…</p>}
        <p className="credit">Franco Guiragossian · <a href="https://dataviz.ar">dataviz.ar</a></p>
      </aside>

      {meta && zoom < GRID_MIN_ZOOM && !picked && (
        <div className="hint">Acercate para ver las parcelas</div>
      )}

      {picked && <Card info={picked} meta={meta} onGo={goToNumber} lookups={lookups.current}
        onClose={() => { setPicked(null); map.current.getSource('picked').setData(EMPTY) }} />}
    </div>
  )
}

function Card({ info, meta, onClose, onGo, lookups }) {
  return (
    <section className="card">
      <button className="close" onClick={onClose} aria-label="Cerrar">×</button>
      {info.kind === 'parcel' && <Parcel info={info} meta={meta} onGo={onGo} lookups={lookups} />}
      {info.kind === 'held' && (
        <>
          <p className="kicker">No se reparte</p>
          <h2>{info.name}</h2>
          <p className="sub">{info.what}</p>
          <p>{WHY[info.what] ?? 'Nadie puede vivir acá, así que no se reparte.'}</p>
        </>
      )}
      {info.kind === 'edge' && (
        <>
          <p className="kicker">No se reparte</p>
          <h2>Entre parcelas</h2>
          <p>Acá no entra una parcela entera: es un borde, un espejo de agua chico o un espacio público.</p>
        </>
      )}
      {info.kind === 'outside' && (
        <>
          <p className="kicker">Fuera del reparto</p>
          <h2>No es parte del reparto</h2>
          <p>Solo se reparte el territorio continental, Tierra del Fuego y las Islas Malvinas.</p>
        </>
      )}
    </section>
  )
}

function Parcel({ info, meta, onGo, lookups }) {
  const { cell, province, neighbours, terrain: t } = info
  const n = (x) => (x ? <button className="link" onClick={() => onGo(x)}>{fmt(x)}</button> : <span className="none">—</span>)
  const unclaimed = cell.number > meta.population
  const km = (d) => (d == null ? '—' : d.km < 1 ? `${fmt(Math.round(d.km * 1000))} m` : `${fmt(d.km, d.km < 10 ? 1 : 0)} km`)
  const named = (d) => (d ? <>{d.name}<span className="dist">{km(d)}</span></> : '—')
  const town = t && t !== 'error' && t.town ? t.town.name : null

  return (
    <>
      <p className="kicker">Parcela {fmt(cell.number)} de {fmt(meta.parcels)}</p>
      <h2>{unclaimed ? 'Sin dueño' : 'Tu terreno'}</h2>
      <p className="sub">
        {unclaimed
          ? `Una de las ${fmt(meta.parcels - meta.population)} parcelas que sobran cuando todos ya tienen la suya.`
          : `${fmt(meta.area_m2 / 1e4, 1)} ha ${town ? `cerca de ${town}, ` : 'en '}${province}`}
      </p>

      {!t && <p className="loading">Midiendo tu terreno…</p>}
      {t === 'error' && <p className="loading">No pudimos leer los datos de este terreno. Probá de nuevo.</p>}

      {t && t !== 'error' && <Terrain t={t} km={km} named={named}
        share={!unclaimed && <Share info={info} meta={meta} lookups={lookups} />} />}

      <div className="neighbours">
        <span>Parcelas vecinas</span>
        <div className="compass">
          <div className="n">{n(neighbours.north)}</div>
          <div className="w">{n(neighbours.west)}</div>
          <div className="me">Esta</div>
          <div className="e">{n(neighbours.east)}</div>
          <div className="s">{n(neighbours.south)}</div>
        </div>
      </div>
    </>
  )
}

const COVER = [
  ['vegDense', 'Vegetación densa', '#3f8f3a'],
  ['vegSparse', 'Vegetación rala o pastizal', '#a3b85c'],
  ['bare', 'Suelo desnudo, roca o construcciones', '#b59a76'],
  ['water', 'Agua', '#4f7fc4'],
  ['snow', 'Nieve o hielo', '#e8eef5'],
]
const VERDICT = ['No', 'Difícil', 'Con esfuerzo', 'Sí']

// Share: builds the image once, then offers the phone's share sheet, WhatsApp, download and copy
function Share({ info, meta, lookups }) {
  const [state, setState] = useState(null)          // null | 'making' | { url, blob, text, link }
  const [note, setNote] = useState('')

  const make = async () => {
    setState('making')
    const blob = await shareImage(info, meta, lookups.grid, lookups.argentina)
    const { text, url: link } = shareText(info, meta)
    setState({ url: URL.createObjectURL(blob), blob, text, link })
  }
  useEffect(() => () => { if (state?.url) URL.revokeObjectURL(state.url) }, [state])

  if (!state || state === 'making') {
    return (
      <button className="primary share-btn" onClick={make} disabled={state === 'making'}>
        {state === 'making' ? 'Armando tu imagen…' : 'Compartir mi terreno'}
      </button>
    )
  }

  const file = new File([state.blob], `mi-terreno-${info.cell.number}.png`, { type: 'image/png' })
  const canShareFile = navigator.canShare?.({ files: [file] })
  const flash = (msg) => { setNote(msg); setTimeout(() => setNote(''), 2500) }
  const native = () => navigator.share({ files: [file], text: state.text }).catch(() => {})
  const whatsapp = () => window.open(`https://wa.me/?text=${encodeURIComponent(state.text)}`, '_blank', 'noopener')
  const download = () => Object.assign(document.createElement('a'), { href: state.url, download: file.name }).click()
  const copyImage = () => navigator.clipboard.write([new ClipboardItem({ 'image/png': state.blob })])
    .then(() => flash('Imagen copiada')).catch(() => flash('Tu navegador no deja copiar imágenes: descargala'))
  const copyLink = () => navigator.clipboard.writeText(state.link).then(() => flash('Link copiado'))

  return (
    <div className="share">
      <img src={state.url} alt="Imagen para compartir con tu terreno" />
      <div className="share-actions">
        {canShareFile && <button className="primary" onClick={native}>Compartir</button>}
        <button onClick={whatsapp}>WhatsApp</button>
        <button onClick={download}>Descargar</button>
        {'ClipboardItem' in window && <button onClick={copyImage}>Copiar imagen</button>}
        <button onClick={copyLink}>Copiar link</button>
      </div>
      <p className="fine">{note || (canShareFile ? 'En el celular, “Compartir” manda la imagen directo a WhatsApp.'
        : 'WhatsApp manda el link; para sumar la imagen, descargala o copiala y pegala en el chat.')}</p>
    </div>
  )
}

function Score({ t }) {
  if (!t.rank) return null
  return (
    <div className="score">
      <div className="score-head">
        <b>{rankText(t.rank)}</b>
        <span>de los terrenos del país · {t.score.total}/100</span>
      </div>
      <ul>
        {SCORE_PARTS.map(([k, label, max]) => (
          <li key={k}>
            <span>{label}</span>
            <i><em style={{ width: `${(100 * t.score.parts[k]) / max}%` }} /></i>
            <small>{Math.round(t.score.parts[k])}/{max}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Terrain({ t, km, named, share }) {
  const pct = (x) => `${fmt(Math.round(x * 100))}%`
  return (
    <>
      {t.badges.length > 0 && (
        <ul className="badges">{t.badges.map(([icon, label]) => <li key={label}><span>{icon}</span>{label}</li>)}</ul>
      )}
      <Score t={t} />
      {share}

      <h3>El terreno</h3>
      <dl>
        {t.elev && <><dt>Altura</dt><dd>{fmt(Math.round(t.elev.mean))} m s. n. m. · desnivel de {fmt(Math.round(t.elev.relief))} m</dd></>}
        {t.ecoregion && <><dt>Ecorregión</dt><dd>{t.ecoregion}</dd></>}
      </dl>
      {t.cover && (
        <div className="cover">
          <div className="bar">
            {COVER.map(([k, , col]) => t.cover[k] > 0 && <span key={k} style={{ width: pct(t.cover[k]), background: col }} />)}
          </div>
          <ul>
            {COVER.filter(([k]) => t.cover[k] >= 0.05).map(([k, label, col]) => (
              <li key={k}><i style={{ background: col }} />{label} <b>{pct(t.cover[k])}</b></li>
            ))}
          </ul>
          <p className="fine">Según los colores de la imagen satelital de la parcela.</p>
        </div>
      )}

      {t.climate && (
        <>
          <h3>Clima</h3>
          <div className="equiv three">
            <div><b>{fmt(t.climate.rain)}</b><span>mm de lluvia al año</span></div>
            <div><b>{fmt(t.climate.temp, 1)}°</b><span>temperatura media</span></div>
            <div><b>{fmt(t.daylight, 1)} h</b><span>de luz en invierno</span></div>
          </div>
        </>
      )}

      <h3>A cuánto queda</h3>
      <dl className="near">
        <dt>Pueblo</dt><dd>{named(t.town)}</dd>
        {t.city && t.city.name !== t.town?.name && <><dt>Ciudad</dt><dd>{named(t.city)}</dd></>}
        <dt>Hospital</dt><dd>{named(t.hospital)}</dd>
        <dt>Escuela</dt><dd><span className="dist">{km(t.school)}</span></dd>
        <dt>Ruta nacional</dt><dd>{t.route && t.route.km < 300 ? named(t.route) : <span className="none">No hay rutas nacionales cerca</span>}</dd>
        <dt>Aeropuerto</dt><dd>{named(t.airport)}</dd>
        <dt>Mar argentino</dt><dd><span className="dist">{km(t.sea)}</span></dd>
        <dt>Agua dulce</dt><dd>{named(t.fresh)}</dd>
        <dt>Obelisco</dt><dd><span className="dist">{km({ km: t.obelisco })}</span></dd>
      </dl>

      <h3>Vecinos</h3>
      <p className="people">
        {t.people10 >= 1
          ? <>Según WorldPop, hoy {t.people10 < 1.5 ? <>vive <b>una</b> persona</> : <>viven unas <b>{fmt(Math.round(t.people10))}</b> personas</>} a menos de 10 km.</>
          : <>Según WorldPop, no hay casas habitadas a menos de 10 km.</>}
      </p>

      <div className={`verdict v${t.farm.level}`}>
        <span>¿Podrías vivir de tu terreno?</span>
        <b>{VERDICT[t.farm.level]}</b>
        <p>{t.farm.text}</p>
      </div>
    </>
  )
}
