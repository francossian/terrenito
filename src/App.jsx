import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import { buildGrid, cellPolygon } from './grid.js'
import { featureFinder, distanceKm, outsideMask } from './geo.js'
import { describe, loadTerrain, quickScore } from './terrain.js'
import { SCORE_PARTS, rankText } from './score.js'
import { shareImage, shareText } from './share.js'
import { P } from './palette.js'
import Social from './Social.jsx'

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
    paint: { 'text-color': P.natureLine, ...halo },
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

// Phones get their own layout: a top bar, a big button in thumb reach, a bottom sheet for the card
const MOBILE_Q = '(max-width: 720px)'
const isMobileNow = () => window.matchMedia(MOBILE_Q).matches
function useIsMobile() {
  const [mobile, setMobile] = useState(isMobileNow)
  useEffect(() => {
    const q = window.matchMedia(MOBILE_Q)
    const on = () => setMobile(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return mobile
}

export default function App() {
  const mapDiv = useRef(null)
  const map = useRef(null)
  const lookups = useRef(null)
  const [meta, setMeta] = useState(null)
  const [zoom, setZoom] = useState(4)
  const [picked, setPicked] = useState(null)
  const [query, setQuery] = useState('')
  const [fromLink, setFromLink] = useState(null)       // parcel number someone shared with this visitor
  const [rival, setRival] = useState(null)             // the other parcel in a comparison
  const [labels, setLabels] = useState(true)
  const mobile = useIsMobile()
  const [panelOpen, setPanelOpen] = useState(() => !isMobileNow())

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
    if (isMobileNow()) setPanelOpen(false)                       // phones: the card replaces the panel
    map.current.getSource('picked').setData(info.kind === 'parcel' ? cellPolygon(info.cell) : EMPTY)
    if (info.kind === 'parcel') {
      history.replaceState(null, '', `#parcela=${info.cell.number}`)
      if (fly) {
        map.current.fitBounds([[info.cell.w, info.cell.s], [info.cell.e, info.cell.n]],
          { padding: isMobileNow()   // phones: keep it above the bottom sheet
            ? { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 40, right: 40 } : 120,
          maxZoom: 14.5, duration: 2500 })
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
      fitBoundsOptions: { padding: isMobileNow() ? { top: 90, bottom: 170, left: 20, right: 20 }
        : { top: 40, bottom: 40, left: 380, right: 40 } },
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

        m.addLayer({ id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': P.bg, 'fill-opacity': 0.55 } })
        m.addLayer({ id: 'nature-fill', type: 'fill', source: 'nature', paint: { 'fill-color': P.nature, 'fill-opacity': 0.3 } })
        m.addLayer({ id: 'nature-line', type: 'line', source: 'nature', paint: { 'line-color': P.natureLine, 'line-width': 0.8, 'line-opacity': 0.7 } })
        m.addLayer({ id: 'held-fill', type: 'fill', source: 'held', paint: { 'fill-color': P.held, 'fill-opacity': P.held === '#ffffff' ? 0.2 : 0.28 } })
        m.addLayer({ id: 'held-line', type: 'line', source: 'held', paint: { 'line-color': P.heldLine, 'line-width': 1, 'line-opacity': 0.8 } })
        m.addLayer({ id: 'parks-fill', type: 'fill', source: 'parks', minzoom: 11, paint: { 'fill-color': P.held, 'fill-opacity': P.held === '#ffffff' ? 0.25 : 0.35 } })
        m.addLayer({ id: 'country', type: 'line', source: 'country', paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.85 } })
        m.addLayer({
          id: 'parcels', type: 'line', source: 'parcels',
          paint: { 'line-color': '#ffffff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 15, 0.7], 'line-width': 0.7 },
        })
        m.addLayer({ id: 'picked-fill', type: 'fill', source: 'picked', paint: { 'fill-color': P.accent, 'fill-opacity': 0.25 } })
        m.addLayer({ id: 'picked-halo', type: 'line', source: 'picked', paint: { 'line-color': P.bg, 'line-width': 6, 'line-opacity': 0.7 } })
        m.addLayer({ id: 'picked-line', type: 'line', source: 'picked', paint: { 'line-color': P.accent, 'line-width': 3 } })

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
        if (hash) { goToNumber(Number(hash[1])); setFromLink(Number(hash[1])) }
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

  // Comparisons: the other parcel's score is computed from the prepared layers only, on the spot
  const summary = async (cell) => {
    const s = await quickScore(cell)
    return { ...s, province: lookups.current.province((cell.w + cell.e) / 2, (cell.n + cell.s) / 2)?.properties.name ?? '' }
  }
  const mine = async () => {                       // "give me mine": the shared parcel becomes the rival
    if (picked?.cell) setRival(await summary(picked.cell))
    random()
  }
  const compareWith = async (n) => {
    const cell = lookups.current?.grid.cellByNumber(n)
    if (!cell) return false
    setRival(await summary(cell))
    return true
  }
  const search = (e) => {
    e.preventDefault()
    const n = Number(query.replace(/[^\d]/g, ''))
    if (n) goToNumber(n)
  }

  const ha = meta ? meta.area_m2 / 1e4 : 0
  const heldPct = meta ? 100 * (1 - meta.shared_km2 / meta.country_km2) : 0

  return (
    <div className={`app ${mobile ? 'mobile' : ''}`}>
      <div ref={mapDiv} className="map" />

      {mobile && !panelOpen && (
        <header className="m-top">
          <div>
            <h1>Tu terrenito</h1>
            <p>{meta ? `${fmt(ha, 1)} ha para cada argentino. ¿Dónde te toca?` : 'Midiendo el país…'}</p>
          </div>
          <button className="m-info" onClick={() => setPanelOpen(true)} aria-label="Cómo funciona">i</button>
        </header>
      )}

      {mobile && !panelOpen && !picked && meta && (
        <div className="m-bottom">
          <button className="primary big" onClick={random}>Dame mi terrenito</button>
          <form onSubmit={search} className="search">
            <input inputMode="numeric" placeholder="¿Ya tenés número? Buscalo"
              value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Número de parcela" />
            <button type="submit">Ir</button>
          </form>
        </div>
      )}

      <aside className={`panel ${panelOpen ? '' : 'closed'} ${mobile && panelOpen ? 'sheet' : ''}`}
        hidden={mobile && !panelOpen}>
        <button className="toggle" onClick={() => setPanelOpen(!panelOpen)}
          aria-label={panelOpen ? 'Cerrar' : 'Mostrar el panel'}>
          {panelOpen ? (mobile ? '×' : '–') : 'i'}
        </button>
        <p className="kicker">#30DayMapChallenge · Día 8 · Utopía</p>
        <h1>Tu terrenito en Argentina</h1>
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
              <button className="primary" onClick={() => { random(); if (mobile) setPanelOpen(false) }}>Dame mi terrenito</button>
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
        <Social />
      </aside>

      {meta && !mobile && zoom < GRID_MIN_ZOOM && !picked && (
        <div className="hint">Acercate para ver las parcelas</div>
      )}

      {picked && (!mobile || !panelOpen) && <Card key={picked.cell?.number ?? picked.kind} info={picked} meta={meta}
        onGo={goToNumber} lookups={lookups.current} mobile={mobile} onAnother={random}
        fromLink={fromLink} rival={rival} onMine={mine} onCompare={compareWith}
        onClose={() => { setPicked(null); map.current.getSource('picked').setData(EMPTY) }} />}
    </div>
  )
}

// On phones the card is a bottom sheet: it opens half-way (the score and the buttons) and a tap on
// the handle opens the full card. Its own footer keeps "Compartir" and "Otro terrenito" in reach
function Card({ info, meta, onClose, onGo, lookups, mobile, onAnother, fromLink, rival, onMine, onCompare }) {
  const shared = info.kind === 'parcel' && info.cell.number === fromLink && !rival   // someone sent this one
  const [open, setOpen] = useState(false)
  const [shareAsk, setShareAsk] = useState(0)
  const oneTap = useRef(null)                                  // the phone's share sheet, once the image exists
  const canShare = info.kind === 'parcel' && info.terrain && info.terrain !== 'error' && info.cell.number <= meta.population
  const share = () => {
    if (oneTap.current) return oneTap.current()
    setOpen(true); setShareAsk((k) => k + 1)                   // no share sheet: show the image and its buttons
  }

  return (
    <>
    <section className={`card ${mobile ? `sheet ${open ? 'open' : 'peek'}` : ''}`}>
      {mobile && (
        <button className="handle" onClick={() => setOpen(!open)} aria-label={open ? 'Achicar la ficha' : 'Ver la ficha completa'}>
          <span />{open ? 'Achicar' : 'Ver ficha completa'}
        </button>
      )}
      <button className="close" onClick={onClose} aria-label="Cerrar">×</button>
      {shared && (
        <div className="invite">
          <p>Alguien te compartió su terrenito. ¿Y a vos qué te toca?</p>
          <button className="primary" onClick={onMine}>Dame el mío y comparemos</button>
        </div>
      )}
      {info.kind === 'parcel' && <Parcel info={info} meta={meta} onGo={onGo} lookups={lookups} shareAsk={shareAsk}
        rival={rival} onCompare={onCompare} shared={shared}
        mobile={mobile} register={(fn) => { oneTap.current = fn }} />}
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
    {mobile && (
      <div className="m-foot">
        {shared && <button className="primary" onClick={onMine}>Dame el mío</button>}
        {canShare && !shared && <button className="primary" onClick={share}>Compartir</button>}
        <button className={canShare || shared ? '' : 'primary'} onClick={onAnother}>Otro terrenito</button>
      </div>
    )}
    </>
  )
}

function Parcel({ info, meta, onGo, lookups, shareAsk, mobile, register, rival, onCompare, shared }) {
  const { cell, province, neighbours, terrain: t } = info
  const n = (x) => (x ? <button className="link" onClick={() => onGo(x)}>{fmt(x)}</button> : <span className="none">—</span>)
  const unclaimed = cell.number > meta.population
  const km = (d) => (d == null ? '—' : d.km < 1 ? `${fmt(Math.round(d.km * 1000))} m` : `${fmt(d.km, d.km < 10 ? 1 : 0)} km`)
  const named = (d) => (d ? <>{d.name}<span className="dist">{km(d)}</span></> : '—')
  const town = t && t !== 'error' && t.town ? t.town.name : null

  return (
    <>
      <p className="kicker">Parcela {fmt(cell.number)} de {fmt(meta.parcels)}</p>
      <h2>{unclaimed ? 'Sin dueño' : shared ? 'El terrenito que te compartieron' : 'Tu terrenito'}</h2>
      <p className="sub">
        {unclaimed
          ? `Una de las ${fmt(meta.parcels - meta.population)} parcelas que sobran cuando todos ya tienen la suya.`
          : `${fmt(meta.area_m2 / 1e4, 1)} ha ${town ? `cerca de ${town}, ` : 'en '}${province}`}
      </p>

      {!t && <p className="loading">Midiendo tu terrenito…</p>}
      {t === 'error' && <p className="loading">No pudimos leer los datos de este terreno. Probá de nuevo.</p>}

      {t && t !== 'error' && rival && rival.number !== cell.number && (
        <Versus mine={t} rival={rival} onGo={onGo} />
      )}

      {t && t !== 'error' && <Terrain t={t} km={km} named={named}
        share={!unclaimed && <Share info={info} meta={meta} lookups={lookups} ask={shareAsk} auto={mobile} register={register} />} />}

      {t && t !== 'error' && <CompareForm onCompare={onCompare} meta={meta} />}

      <div className="neighbours">
        <span>Parcelas vecinas</span>
        <div className="compass">
          <div className="n">{n(neighbours.north)}</div>
          <div className="w">{n(neighbours.west)}</div>
          <div className="me">Tu terrenito</div>
          <div className="e">{n(neighbours.east)}</div>
          <div className="s">{n(neighbours.south)}</div>
        </div>
      </div>
    </>
  )
}

// Your parcel against the other person's: score, ranking and who wins
function Versus({ mine, rival, onGo }) {
  const diff = mine.score.total - rival.total
  const verdict = diff > 0 ? `¡Ganaste por ${diff} ${diff === 1 ? 'punto' : 'puntos'}!`
    : diff < 0 ? `Esta vez perdiste por ${-diff} ${diff === -1 ? 'punto' : 'puntos'}` : '¡Empate!'
  return (
    <div className="versus">
      <p className="verdict-line">{verdict}</p>
      <div className="vs-row">
        <div className="vs-side me">
          <span>Tu terrenito</span>
          <b>{mine.score.total}</b>
          <small>{mine.rank ? rankText(mine.rank) : ''}</small>
        </div>
        <i>vs</i>
        <div className="vs-side">
          <span>El de la otra persona</span>
          <b>{rival.total}</b>
          <small>{rival.town ? `cerca de ${rival.town}` : rival.province}</small>
          <button className="link" onClick={() => onGo(rival.number)}>Ver parcela {fmt(rival.number)}</button>
        </div>
      </div>
    </div>
  )
}

function CompareForm({ onCompare, meta }) {
  const [n, setN] = useState('')
  const [msg, setMsg] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    const num = Number(n.replace(/[^\d]/g, ''))
    const ok = num && (await onCompare(num))
    setMsg(ok ? '' : `Poné un número entre 1 y ${fmt(meta.parcels)}`)
  }
  return (
    <form className="compare-form" onSubmit={submit}>
      <label htmlFor="cmp">Compará con alguien</label>
      <div className="search">
        <input id="cmp" inputMode="numeric" placeholder="Número de su parcela" value={n}
          onChange={(e) => setN(e.target.value)} />
        <button type="submit">Comparar</button>
      </div>
      {msg && <p className="fine">{msg}</p>}
    </form>
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
// auto: build the image as soon as the card opens (phones), so "Compartir" in the footer can open the
// share sheet right away; register: hands the footer that one-tap share, once it exists
function Share({ info, meta, lookups, ask = 0, auto = false, register }) {
  const [state, setState] = useState(null)          // null | 'making' | { url, blob, text, link }
  const [note, setNote] = useState('')
  const box = useRef(null)

  const make = async () => {
    setState('making')
    const blob = await shareImage(info, meta, lookups.grid, lookups.argentina)
    const { text, url: link } = shareText(info, meta)
    setState({ url: URL.createObjectURL(blob), blob, text, link })
  }
  useEffect(() => () => { if (state?.url) URL.revokeObjectURL(state.url) }, [state])
  useEffect(() => { if (auto) make() }, [])                                       // eslint-disable-line
  useEffect(() => {
    if (!ask) return
    if (!state) make()
    setTimeout(() => box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350)
  }, [ask])                                                                      // eslint-disable-line

  const file = state?.blob && new File([state.blob], `mi-terrenito-${info.cell.number}.png`, { type: 'image/png' })
  const canShareFile = file && navigator.canShare?.({ files: [file] })
  useEffect(() => {
    register?.(canShareFile ? () => navigator.share({ files: [file], text: state.text }).catch(() => {}) : null)
  }, [state])                                                                    // eslint-disable-line

  if (!state || state === 'making') {
    return (
      <button ref={box} className="primary share-btn" onClick={make} disabled={state === 'making'}>
        {state === 'making' ? 'Armando tu imagen…' : 'Compartir mi terrenito'}
      </button>
    )
  }

  const flash = (msg) => { setNote(msg); setTimeout(() => setNote(''), 2500) }
  const native = () => navigator.share({ files: [file], text: state.text }).catch(() => {})
  const whatsapp = () => window.open(`https://wa.me/?text=${encodeURIComponent(state.text)}`, '_blank', 'noopener')
  const download = () => Object.assign(document.createElement('a'), { href: state.url, download: file.name }).click()
  const copyImage = () => navigator.clipboard.write([new ClipboardItem({ 'image/png': state.blob })])
    .then(() => flash('Imagen copiada')).catch(() => flash('Tu navegador no deja copiar imágenes: descargala'))
  const copyLink = () => navigator.clipboard.writeText(state.link).then(() => flash('Link copiado'))

  return (
    <div className="share" ref={box}>
      <img src={state.url} alt="Imagen para compartir con tu terrenito" />
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
