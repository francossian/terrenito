// Colour palette: Argentine celeste on night blue. A table, so others can be added and tried with ?paleta=<name>
//   accent: the chosen parcel, buttons, the score    accentInk: text on top of the accent
//   accent2: badges and highlights                   held: parks, reserves, plazas, military land
//   nature: water, glaciers, high mountains          panel: card and panel background

export const PALETTES = {
  // celeste for what you pick, a deeper cobalt for water, white for land held back
  celeste: {
    label: 'Celeste', accent: '#7CC7F5', accentInk: '#06182b', accent2: '#7CC7F5',
    held: '#ffffff', heldLine: '#ffffff', nature: '#3E72D6', natureLine: '#8FB2EE',
    bg: '#0a1422', panel: '#0F1B2D', ink: '#F5F3EE', ink2: '#a9b4c4',
  },
}

const DEFAULT = 'celeste'
const asked = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('paleta') : null
export const P = PALETTES[asked] ?? PALETTES[DEFAULT]

// "#rrggbb" + alpha -> "rgba(...)"
export const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

// Expose the palette to the stylesheet as CSS variables
export function applyPalette() {
  const s = document.documentElement.style
  for (const [k, v] of Object.entries(P)) if (k !== 'label') s.setProperty(`--${k}`, v)
  s.setProperty('--panel', alpha(P.panel, 0.88))       // the stylesheet's names for these two
  s.setProperty('--ink-2', P.ink2)
  s.setProperty('--panel-solid', P.panel)
}
