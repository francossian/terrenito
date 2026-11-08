// The image people share: the parcel on the satellite map on the left, its score and a few
// facts on the right. Wide (1600 × 900) so it reads well in WhatsApp and social feeds.
// Drawn on a canvas from the same tiles and data the app uses.

import { rankText } from './score.js'
import { P, alpha } from './palette.js'

const W = 1600, H = 900
const MAP_W = 860
const Z = 15                                    // ~240 m parcel is ~60 px wide here
const C = {
  bg: P.bg, panel: P.panel, ink: P.ink, ink2: P.ink2, accent: P.accent, accent2: P.accent2, accentInk: P.accentInk,
  line: 'rgba(255,255,255,0.12)',
}
const VERDICT = ['No', 'Difícil', 'Con esfuerzo', 'Sí']
const VERDICT_COL = ['#d9534f', '#e8a33d', '#c9c45a', '#5cb85c']

const fmt = (n, d = 0) => n.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d })
const km = (x) => (x == null ? '—' : x < 1 ? `${fmt(Math.round(x * 1000))} m` : `${fmt(x, x < 10 ? 1 : 0)} km`)

// ---- Web Mercator ----------------------------------------------------------------------

const worldPx = (lon, lat) => {
  const n = 256 * 2 ** Z, r = (lat * Math.PI) / 180
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n]
}
const worldLonLat = (x, y) => {
  const n = 256 * 2 ** Z
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI]
}

async function tile(z, x, y) {
  const url = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`
  const blob = await fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
  return createImageBitmap(blob)
}

// ---- Drawing helpers -------------------------------------------------------------------

const font = (size, weight = 400) => `${weight} ${size}px Inter, system-ui, sans-serif`

// Largest size (down to min) at which the text fits the width
function fit(ctx, text, maxW, size, weight, min = 16) {
  for (let s = size; s >= min; s -= 2) {
    ctx.font = font(s, weight)
    if (ctx.measureText(text).width <= maxW) return s
  }
  return min
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ---- The map half ------------------------------------------------------------------------

async function drawMap(ctx, cell, grid, argentina) {
  const [cx, cy] = worldPx((cell.w + cell.e) / 2, (cell.n + cell.s) / 2)
  const ox = cx - MAP_W / 2, oy = cy - H / 2 - 20
  const toPx = (lon, lat) => { const [x, y] = worldPx(lon, lat); return [x - ox, y - oy] }

  ctx.fillStyle = '#1d2327'
  ctx.fillRect(0, 0, MAP_W, H)
  const jobs = []
  for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++) {
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + MAP_W) / 256); tx++) {
      jobs.push(tile(Z, tx, ty).then((img) => ctx.drawImage(img, tx * 256 - ox, ty * 256 - oy)).catch(() => {}))
    }
  }
  await Promise.all(jobs)

  // Neighbouring parcels
  const [west, north] = worldLonLat(ox, oy)
  const [east, south] = worldLonLat(ox + MAP_W, oy + H)
  const lines = grid.linesIn({ west, east, south, north }, 6000)
  if (lines) {
    ctx.strokeStyle = 'rgba(255,255,255,0.32)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const seg of lines.geometry.coordinates) {
      const [x0, y0] = toPx(...seg[0]), [x1, y1] = toPx(...seg[1])
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1)
    }
    ctx.stroke()
  }

  // The parcel
  const [x0, y0] = toPx(cell.w, cell.n), [x1, y1] = toPx(cell.e, cell.s)
  ctx.fillStyle = alpha(P.accent, 0.28)
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  ctx.strokeStyle = alpha(P.bg, 0.75)            // dark halo, so a light accent reads on any ground
  ctx.lineWidth = 9
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
  ctx.strokeStyle = C.accent
  ctx.lineWidth = 4
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)

  // "Tu terrenito" tag above it
  ctx.font = font(20, 700)
  const label = 'Tu terrenito', lw = ctx.measureText(label).width + 28
  const lx = (x0 + x1) / 2 - lw / 2, ly = y0 - 58
  roundRect(ctx, lx, ly, lw, 38, 19)
  ctx.fillStyle = C.accent
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo((x0 + x1) / 2 - 8, ly + 38); ctx.lineTo((x0 + x1) / 2 + 8, ly + 38); ctx.lineTo((x0 + x1) / 2, ly + 48)
  ctx.fill()
  ctx.fillStyle = C.accentInk
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, (x0 + x1) / 2, ly + 20)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // Fade into the text panel
  const g = ctx.createLinearGradient(MAP_W - 180, 0, MAP_W, 0)
  g.addColorStop(0, alpha(P.panel, 0))
  g.addColorStop(1, C.panel)
  ctx.fillStyle = g
  ctx.fillRect(MAP_W - 180, 0, 180, H)

  drawLocator(ctx, argentina, (cell.w + cell.e) / 2, (cell.n + cell.s) / 2)
}

// Small Argentina, with a dot where the parcel is
function drawLocator(ctx, argentina, lon, lat) {
  const bx = 36, by = H - 36 - 290, bw = 170, bh = 290
  roundRect(ctx, bx, by, bw, bh, 14)
  ctx.fillStyle = 'rgba(12,16,20,0.78)'
  ctx.fill()
  const [w, e, s, n] = [-74, -53.5, -55.2, -21.7]
  const k = Math.cos((38 * Math.PI) / 180)
  const scale = Math.min((bw - 30) / ((e - w) * k), (bh - 30) / (n - s))
  const px = (x, y) => [bx + bw / 2 + (x - (w + e) / 2) * k * scale, by + bh / 2 - (y - (s + n) / 2) * scale]
  ctx.beginPath()
  for (const f of argentina.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const p of polys) {
      p[0].forEach(([x, y], i) => { const [X, Y] = px(x, y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y) })
      ctx.closePath()
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.lineWidth = 1
  ctx.stroke()
  const [dx, dy] = px(lon, lat)
  ctx.beginPath(); ctx.arc(dx, dy, 11, 0, 2 * Math.PI)
  ctx.fillStyle = alpha(P.accent, 0.35); ctx.fill()
  ctx.beginPath(); ctx.arc(dx, dy, 5, 0, 2 * Math.PI)
  ctx.fillStyle = C.accent; ctx.fill()
}

// ---- The text half ---------------------------------------------------------------------

function drawPanel(ctx, { cell, meta, province, t }) {
  const x = MAP_W + 56, maxW = W - x - 64
  ctx.fillStyle = C.panel
  ctx.fillRect(MAP_W, 0, W - MAP_W, H)

  ctx.fillStyle = C.accent
  ctx.font = font(17, 700)
  ctx.letterSpacing = '3px'
  ctx.fillText('TU TERRENITO EN ARGENTINA', x, 92)
  ctx.letterSpacing = '0px'

  const place = t.town ? `Cerca de ${t.town.name}` : province
  ctx.fillStyle = C.ink
  ctx.font = font(fit(ctx, place, maxW, 52, 700, 30), 700)
  ctx.fillText(place, x, 156)

  const sub = `${t.town ? `${province} · ` : ''}parcela ${fmt(cell.number)}`
  ctx.fillStyle = C.ink2
  ctx.font = font(fit(ctx, sub, maxW, 23, 400), 400)
  ctx.fillText(sub, x, 196)

  // Score
  if (t.rank) {
    const big = rankText(t.rank)
    ctx.fillStyle = C.accent2
    ctx.font = font(fit(ctx, big, maxW, 104, 800, 56), 800)
    ctx.fillText(big, x - 4, 318)
    ctx.fillStyle = C.ink2
    ctx.font = font(22, 400)
    ctx.fillText(`de los terrenos del país · puntaje ${t.score.total}/100`, x, 358)
  }

  // Badges, at most two rows
  let bx = x, by = 400
  ctx.font = font(19, 600)
  for (const [icon, label] of t.badges.slice(0, 6)) {
    const text = `${icon}  ${label}`
    const w = ctx.measureText(text).width + 30
    if (bx + w > x + maxW) { bx = x; by += 50; if (by > 450) break }
    roundRect(ctx, bx, by, w, 40, 20)
    ctx.fillStyle = alpha(P.accent2, 0.14); ctx.fill()
    ctx.strokeStyle = alpha(P.accent2, 0.5); ctx.lineWidth = 1.5; ctx.stroke()
    ctx.fillStyle = C.ink
    ctx.fillText(text, bx + 15, by + 27)
    bx += w + 10
  }

  // Facts, 3 × 2
  const facts = [
    ['Superficie', `${fmt(meta.area_m2 / 1e4, 1)} ha`],
    ['Altura', t.elev ? `${fmt(Math.round(t.elev.mean))} m` : '—'],
    ['Lluvia', t.climate ? `${fmt(t.climate.rain)} mm/año` : '—'],
    ['Hospital', km(t.hospital?.km)],
    ['Agua dulce', km(t.fresh?.km)],
    ['Al Obelisco', km(t.obelisco)],
  ]
  const top = 558, colW = maxW / 3
  ctx.strokeStyle = C.line; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x, top - 34); ctx.lineTo(x + maxW, top - 34); ctx.stroke()
  facts.forEach(([label, value], i) => {
    const fx = x + (i % 3) * colW, fy = top + Math.floor(i / 3) * 96
    ctx.fillStyle = C.ink2; ctx.font = font(16, 600)
    ctx.letterSpacing = '1.5px'
    ctx.fillText(label.toUpperCase(), fx, fy)
    ctx.letterSpacing = '0px'
    ctx.fillStyle = C.ink; ctx.font = font(fit(ctx, value, colW - 16, 32, 700, 20), 700)
    ctx.fillText(value, fx, fy + 40)
  })

  // Verdict
  const vy = 772
  ctx.beginPath(); ctx.moveTo(x, vy - 42); ctx.lineTo(x + maxW, vy - 42); ctx.strokeStyle = C.line; ctx.stroke()
  ctx.fillStyle = VERDICT_COL[t.farm.level]
  ctx.beginPath(); ctx.arc(x + 9, vy - 8, 9, 0, 2 * Math.PI); ctx.fill()
  ctx.fillStyle = C.ink2; ctx.font = font(22, 400)
  const q = '¿Podrías vivir de tu terreno?  '
  ctx.fillText(q, x + 30, vy)
  const qw = ctx.measureText(q).width
  ctx.fillStyle = C.ink; ctx.font = font(24, 700)
  ctx.fillText(VERDICT[t.farm.level], x + 30 + qw, vy)

  // Footer
  const site = /^(localhost|127\.)/.test(location.hostname) ? 'terrenito.dataviz.ar' : location.host
  ctx.fillStyle = C.ink; ctx.font = font(24, 700)
  const ask = '¿Y a vos qué te toca?  '
  ctx.fillText(ask, x, H - 56)
  const aw = ctx.measureText(ask).width
  ctx.fillStyle = C.accent; ctx.font = font(24, 600)
  ctx.fillText(site, x + aw, H - 56)
  ctx.fillStyle = C.ink2; ctx.font = font(15, 400)
  ctx.fillText('#30DayMapChallenge · dataviz.ar', x, H - 28)
}

export async function shareImage(info, meta, grid, argentina) {
  await Promise.all([font(52, 700), font(22, 400), font(19, 600), font(104, 800)].map((f) => document.fonts.load(f)))
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)
  await drawMap(ctx, info.cell, grid, argentina)
  drawPanel(ctx, { cell: info.cell, meta, province: info.province, t: info.terrain })
  return new Promise((ok) => canvas.toBlob(ok, 'image/png'))
}

export function shareText(info, meta) {
  const t = info.terrain
  const where = t.town ? `cerca de ${t.town.name}, ${info.province}` : `en ${info.province}`
  const rank = !t.rank ? ''
    : t.rank.top <= 50 ? ` Mi terreno está en el top ${t.rank.top}% del país.`
      : ` Mi terreno es mejor que el ${Math.round(100 * t.rank.better)}% de los del país.`
  const url = `${location.origin}${location.pathname}#parcela=${info.cell.number}`
  return {
    url,
    text: `Si repartiéramos la tierra argentina en partes iguales, me tocarían ${fmt(meta.area_m2 / 1e4, 1)} hectáreas ${where}.${rank} ¿Y a vos qué te toca? Entrá y comparemos: ${url}`,
  }
}
