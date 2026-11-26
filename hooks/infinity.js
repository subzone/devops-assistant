// @ts-check
// The k8s pane's backdrop: a rotating 3D infinity, the DevOps loop.
//
// A wireframe tube around a lemniscate, its two strands crossing at different
// depths, swaying left and right about the vertical axis (never edge-on, so
// it always reads as ∞) and tilted towards the viewer. Each
// frame is drawn into braille dots (2x4 per cell, so the dots are nearly
// square) with a depth buffer, so strands and the tube's far side hide behind
// what is nearer. Shaded from deep navy to ice blue by light and depth, with
// rings and two bright pulses flowing round the loop like a pipeline.
//
// Pure: no `$`. `infinityCells` returns a Raster's `cells` (base64 of
// [codePoint, foreground, background] u32 triplets, little-endian).

const DEFAULT_COLOR = 0x01000000
const LABEL_COLOR = 0x3f8fd8
const TAU = Math.PI * 2

/** Frames per sway (left, right and back) and per lap of a pulse, at FRAME_MS. */
export const FRAME_MS = 83
const SWAY_FRAMES = 120
const SWAY = 0.52
const PULSE_FRAMES = 96

// Braille dot bits by [x][y] within a 2x4 cell.
const BIT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

// Deep navy → blue → azure → cyan → ice.
const STOPS = [
  [0x0b, 0x22, 0x4f],
  [0x12, 0x47, 0x9c],
  [0x1e, 0x7f, 0xdb],
  [0x3f, 0xb4, 0xf2],
  [0xb8, 0xe9, 0xff],
]
const SHADES = 48
const PALETTE = (() => {
  const out = new Uint32Array(SHADES)
  for (let i = 0; i < SHADES; i++) {
    const x = (i / (SHADES - 1)) * (STOPS.length - 1)
    const k = Math.min(STOPS.length - 2, Math.floor(x))
    const f = x - k
    const c = STOPS[k].map((v, j) => Math.round(v + (STOPS[k + 1][j] - v) * f))
    out[i] = (c[0] << 16) | (c[1] << 8) | c[2]
  }
  return out
})()

// Light from the upper left, in front.
const L = (() => {
  const v = [-0.45, -0.6, -0.66]
  const n = Math.hypot(v[0], v[1], v[2])
  return v.map(x => x / n)
})()

const TILT = 0.38
const LINES = 6

/**
 * @typedef {{ cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, bx: number, by: number, bz: number }} Frame3
 * @typedef {{
 *   W: number, H: number, a: number, r: number, D: number,
 *   surf: Float32Array, nSurf: number,
 *   line: Float32Array, nLine: number,
 *   rings: number, ringSteps: number,
 *   zbuf: Float32Array, lum: Float32Array, words: DataView, bytes: Uint8Array,
 *   labelRow: number,
 * }} Geometry
 */

/** @type {Map<string, Geometry>} */
const cache = new Map()

/**
 * The lemniscate of Bernoulli, its strands apart in depth where they cross.
 * @param {number} t @param {number} a
 */
function curve(t, a) {
  const s = Math.sin(t)
  const c = Math.cos(t)
  const d = 1 + s * s
  return [(a * c) / d, (a * s * c) / d, 0.24 * a * s]
}

/**
 * Centre and the tube's two cross-section axes at t.
 * @param {number} t @param {number} a @returns {Frame3}
 */
function frameAt(t, a) {
  const [cx, cy, cz] = curve(t, a)
  const p = curve(t + 1e-3, a)
  const m = curve(t - 1e-3, a)
  let tx = p[0] - m[0]
  let ty = p[1] - m[1]
  let tz = p[2] - m[2]
  const tl = Math.hypot(tx, ty, tz) || 1
  tx /= tl
  ty /= tl
  tz /= tl
  // N = T × up(0,0,1), B = N × T
  let nx = ty
  let ny = -tx
  const nl = Math.hypot(nx, ny) || 1
  nx /= nl
  ny /= nl
  const nz = 0
  const bx = ny * tz - nz * ty
  const by = nz * tx - nx * tz
  const bz = nx * ty - ny * tx
  return { cx, cy, cz, nx, ny, nz, bx, by, bz }
}

/**
 * @param {Float32Array} out @param {number} i
 * @param {Frame3} f @param {number} phi @param {number} r @param {number} t
 */
function put(out, i, f, phi, r, t) {
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  const nx = c * f.nx + s * f.bx
  const ny = c * f.ny + s * f.by
  const nz = c * f.nz + s * f.bz
  const o = i * 7
  out[o] = f.cx + r * nx
  out[o + 1] = f.cy + r * ny
  out[o + 2] = f.cz + r * nz
  out[o + 3] = nx
  out[o + 4] = ny
  out[o + 5] = nz
  out[o + 6] = t
}

/** @param {number} cols @param {number} rows @returns {Geometry} */
function geometry(cols, rows) {
  const id = cols + 'x' + rows
  const hit = cache.get(id)
  if (hit) return hit
  const W = cols * 2
  const H = rows * 4
  const a = Math.max(4, Math.min(0.42 * W, 0.56 * H))
  const r = 0.095 * a
  const D = 3.2 * a
  const perimeter = 5.244 * a

  // The tube's surface, for depth only: dense enough to leave no holes.
  const nT = Math.ceil(perimeter * 2)
  const nP = Math.ceil(TAU * r * 2) + 8
  const surf = new Float32Array(nT * nP * 7)
  let k = 0
  for (let i = 0; i < nT; i++) {
    const t = (i / nT) * TAU
    const f = frameAt(t, a)
    for (let j = 0; j < nP; j++) put(surf, k++, f, (j / nP) * TAU, r, t)
  }

  // Lines along the tube.
  const nL = Math.ceil(perimeter * 2.4)
  const line = new Float32Array(LINES * nL * 7)
  k = 0
  for (let i = 0; i < nL; i++) {
    const t = (i / nL) * TAU
    const f = frameAt(t, a)
    for (let j = 0; j < LINES; j++) put(line, k++, f, (j / LINES) * TAU + 0.3, r, t)
  }

  const g = {
    W,
    H,
    a,
    r,
    D,
    surf,
    nSurf: nT * nP,
    line,
    nLine: LINES * nL,
    rings: Math.max(8, Math.round(perimeter / (2.6 * r))),
    ringSteps: Math.ceil(TAU * r * 2.6) + 8,
    zbuf: new Float32Array(W * H),
    lum: new Float32Array(W * H),
    words: new DataView(new ArrayBuffer(cols * rows * 12)),
    bytes: new Uint8Array(0),
    labelRow: 0,
  }
  g.bytes = new Uint8Array(g.words.buffer)

  // The label's row: under the lowest dot the sway ever reaches, so it holds still.
  let bottom = 0
  const ca = Math.cos(TILT)
  const sa = Math.sin(TILT)
  for (const th of [-SWAY, -SWAY / 2, 0, SWAY / 2, SWAY]) {
    const ct = Math.cos(th)
    const st = Math.sin(th)
    for (let i = 0, o = 0; i < g.nSurf; i++, o += 7) {
      const x = surf[o]
      const y = surf[o + 1]
      const z = surf[o + 2]
      const z2 = -ca * st * x + sa * y + ca * ct * z
      const py = H / 2 + (sa * st * x + ca * y - sa * ct * z) * (D / (D + z2))
      if (py > bottom) bottom = py
    }
  }
  g.labelRow = Math.min(rows - 1, Math.floor(bottom / 4) + 1)
  if (cache.size > 6) cache.clear()
  cache.set(id, g)
  return g
}

/**
 * The cells of one frame for a Raster of cols x rows.
 * @param {number} cols @param {number} rows @param {number} frame
 * @param {string} [label] centred under the ∞ (printable ASCII; cut to fit)
 * @returns {string}
 */
export function infinityCells(cols, rows, frame, label) {
  const g = geometry(cols, rows)
  const { W, H, a, r, D, zbuf, lum, words } = g

  // Sway about y, then tilt about x.
  const th = SWAY * Math.sin((frame / SWAY_FRAMES) * TAU)
  const ct = Math.cos(th)
  const st = Math.sin(th)
  const ca = Math.cos(TILT)
  const sa = Math.sin(TILT)
  const m00 = ct
  const m02 = st
  const m10 = sa * st
  const m11 = ca
  const m12 = -sa * ct
  const m20 = -ca * st
  const m21 = sa
  const m22 = ca * ct
  const hx = W / 2
  const hy = H / 2
  const pulse = ((frame % PULSE_FRAMES) / PULSE_FRAMES) * TAU
  const flow = (frame * 0.12) % 1
  const eps = 0.45 * r
  const near = 1.15 * a

  zbuf.fill(Infinity)
  lum.fill(0)

  // Pass 1: depth of the tube's near side.
  const s1 = g.surf
  for (let i = 0, o = 0; i < g.nSurf; i++, o += 7) {
    const nz = m20 * s1[o + 3] + m21 * s1[o + 4] + m22 * s1[o + 5]
    if (nz > 0.2) continue
    const x = s1[o]
    const y = s1[o + 1]
    const z = s1[o + 2]
    const z2 = m20 * x + m21 * y + m22 * z
    const k = D / (D + z2)
    const px = (hx + (m00 * x + m02 * z) * k) | 0
    const py = (hy + (m10 * x + m11 * y + m12 * z) * k) | 0
    if (px < 0 || py < 0 || px >= W || py >= H) continue
    const p = py * W + px
    if (z2 < zbuf[p]) zbuf[p] = z2
  }

  /**
   * Pass 2: one wire point, kept where nothing nearer covers it.
   * @param {Float32Array} s @param {number} o @param {number} glow
   */
  const dot = (s, o, glow) => {
    const x = s[o]
    const y = s[o + 1]
    const z = s[o + 2]
    const z2 = m20 * x + m21 * y + m22 * z
    const k = D / (D + z2)
    const px = (hx + (m00 * x + m02 * z) * k) | 0
    const py = (hy + (m10 * x + m11 * y + m12 * z) * k) | 0
    if (px < 0 || py < 0 || px >= W || py >= H) return
    const p = py * W + px
    if (z2 > zbuf[p] + eps) return
    const n0 = m00 * s[o + 3] + m02 * s[o + 5]
    const n1 = m10 * s[o + 3] + m11 * s[o + 4] + m12 * s[o + 5]
    const n2 = m20 * s[o + 3] + m21 * s[o + 4] + m22 * s[o + 5]
    const lam = Math.max(0, n0 * L[0] + n1 * L[1] + n2 * L[2])
    const depth = Math.min(1, Math.max(0, (z2 + near) / (2 * near)))
    // two pulses, half a loop apart: dev and ops
    let d = Math.abs(((s[o + 6] - pulse) % TAU + TAU) % TAU)
    d = Math.min(d, TAU - d)
    d = Math.min(d, Math.abs(d - Math.PI))
    const hot = Math.exp(-(d * d) / 0.09)
    const v = (0.2 + 0.6 * lam) * (1 - 0.5 * depth) + glow + 0.55 * hot
    if (v > lum[p]) lum[p] = v
  }

  const ln = g.line
  for (let i = 0; i < g.nLine; i++) dot(ln, i * 7, 0)

  const ring = new Float32Array(g.ringSteps * 7)
  for (let q = 0; q < g.rings; q++) {
    const t = ((q + flow) / g.rings) * TAU
    const f = frameAt(t, a)
    for (let j = 0; j < g.ringSteps; j++) put(ring, j, f, (j / g.ringSteps) * TAU, r, t)
    for (let j = 0; j < g.ringSteps; j++) dot(ring, j * 7, 0.08)
  }

  // Dots to braille cells.
  let w = 0
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let bits = 0
      let top = 0
      for (let dx = 0; dx < 2; dx++) {
        const col = BIT[dx]
        for (let dy = 0; dy < 4; dy++) {
          const v = lum[(cy * 4 + dy) * W + cx * 2 + dx]
          if (v > 0) {
            bits |= col[dy]
            if (v > top) top = v
          }
        }
      }
      if (bits) {
        words.setUint32(w, 0x2800 | bits, true)
        words.setUint32(w + 4, PALETTE[Math.min(SHADES - 1, Math.round(Math.min(1, top) * (SHADES - 1)))], true)
      } else {
        words.setUint32(w, 0x20, true)
        words.setUint32(w + 4, DEFAULT_COLOR, true)
      }
      words.setUint32(w + 8, DEFAULT_COLOR, true)
      w += 12
    }
  }

  // The label, centred under the ∞, in a steady mid blue.
  const text = (label ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, cols)
  if (text) {
    const x0 = Math.floor((cols - text.length) / 2)
    for (let i = 0; i < text.length; i++) {
      const o = (g.labelRow * cols + x0 + i) * 12
      words.setUint32(o, text.charCodeAt(i), true)
      words.setUint32(o + 4, LABEL_COLOR, true)
      words.setUint32(o + 8, DEFAULT_COLOR, true)
    }
  }
  return base64(g.bytes)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** @param {Uint8Array} bytes */
function base64(bytes) {
  const native = /** @type {{ toBase64?: () => string }} */ (/** @type {unknown} */ (bytes)).toBase64
  if (typeof native === 'function') return native.call(bytes)
  const n = bytes.length
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < n ? bytes[i + 1] : 0
    const b2 = i + 2 < n ? bytes[i + 2] : 0
    out.push(B64[b0 >> 2], B64[((b0 & 3) << 4) | (b1 >> 4)], i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=', i + 2 < n ? B64[b2 & 63] : '=')
  }
  return out.join('')
}
