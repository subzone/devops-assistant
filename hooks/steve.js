// @ts-check
// Steve, the pane's backdrop: Steve Trash in one hue, bottom right, drawn in
// half blocks (two pixels a cell), with a speech bubble above his head, sound
// rings by his headphones while he listens, and the version under him.
//
// Pure: no `$`. `steveCells` returns a Raster's `cells` (base64 of
// [codePoint, foreground, background] u32 triplets, little-endian).

import { STEVE_FRAMES, STEVE_H, STEVE_W } from './steve-frames.js'

/** @typedef {keyof typeof STEVE_FRAMES} Pose */
/**
 * @typedef {{
 *   pose: Pose,
 *   bubble?: string,
 *   listening?: boolean,
 *   label?: string,
 * }} SteveState
 */

const DEFAULT_COLOR = 0x01000000
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const BORDER = 0x3f8fd8
const TEXT = 0xd6f1ff
const RING = 0x6fc3ff
const LABEL = 0x3f8fd8

// One hue, dark to light: navy → blue → azure → ice.
const STOPS = [
  [0x06, 0x12, 0x26],
  [0x0e, 0x2e, 0x5e],
  [0x1b, 0x5f, 0xb0],
  [0x45, 0x9f, 0xe8],
  [0xa9, 0xdd, 0xff],
  [0xec, 0xf8, 0xff],
]
const TINT = (() => {
  const out = new Uint32Array(255)
  for (let v = 0; v < 255; v++) {
    // lift the darks so the hoodie still reads on a black terminal
    const t = 0.1 + 0.9 * Math.pow(v / 254, 0.85)
    const x = t * (STOPS.length - 1)
    const k = Math.min(STOPS.length - 2, Math.floor(x))
    const f = x - k
    const c = STOPS[k].map((s, j) => Math.round(s + (STOPS[k + 1][j] - s) * f))
    out[v] = (c[0] << 16) | (c[1] << 8) | c[2]
  }
  return out
})()

/** The colour for a light byte (0-254). @param {number} v */
export const tint = v => TINT[Math.max(0, Math.min(254, v | 0))]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i
  return m
})()

/** @param {string} s */
function fromBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX[clean.charCodeAt(i)]
    const b = B64_INDEX[clean.charCodeAt(i + 1)]
    const c = i + 2 < clean.length ? B64_INDEX[clean.charCodeAt(i + 2)] : 0
    const d = i + 3 < clean.length ? B64_INDEX[clean.charCodeAt(i + 3)] : 0
    const n = (a << 18) | (b << 12) | (c << 6) | d
    if (o < out.length) out[o++] = n >> 16
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
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

/** @type {Map<string, Uint8Array>} */
const decoded = new Map()
/** @type {Map<string, Uint8Array>} */
const scaled = new Map()

/** A frame at w x h pixels: light bytes, 255 transparent. @param {Pose} pose @param {number} w @param {number} h */
function pixels(pose, w, h) {
  const id = `${pose}:${w}x${h}`
  const hit = scaled.get(id)
  if (hit) return hit
  let src = decoded.get(pose)
  if (!src) {
    src = fromBase64(STEVE_FRAMES[pose])
    decoded.set(pose, src)
  }
  // Exact area weighting: each target pixel averages the source area it
  // covers, partial source pixels by the part covered, so outlines stay put.
  const out = new Uint8Array(w * h)
  const fx = STEVE_W / w
  const fy = STEVE_H / h
  for (let y = 0; y < h; y++) {
    const ya = y * fy
    const yb = Math.min(STEVE_H, (y + 1) * fy)
    for (let x = 0; x < w; x++) {
      const xa = x * fx
      const xb = Math.min(STEVE_W, (x + 1) * fx)
      let sum = 0
      let lit = 0
      let all = 0
      for (let sy = Math.floor(ya); sy < Math.ceil(yb); sy++) {
        const wy = Math.min(sy + 1, yb) - Math.max(sy, ya)
        for (let sx = Math.floor(xa); sx < Math.ceil(xb); sx++) {
          const wt = wy * (Math.min(sx + 1, xb) - Math.max(sx, xa))
          const v = src[sy * STEVE_W + sx]
          all += wt
          if (v !== 255) {
            sum += v * wt
            lit += wt
          }
        }
      }
      out[y * w + x] = lit * 2 < all ? 255 : Math.round(sum / lit)
    }
  }
  if (scaled.size > 64) scaled.clear()
  scaled.set(id, out)
  return out
}

/** What a bubble may hold: printable ASCII and a few narrow symbols. @param {string} s */
const narrow = s => s.replace(/\s+/g, ' ').replace(/[^\x20-\x7e…✔✖⚠›–—•·]/g, '').trim()

/** Word-wrapped to width, at most max lines, the last cut with …. @param {string} text @param {number} width @param {number} max */
function wrap(text, width, max) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    const w = word.length > width ? word.slice(0, width - 1) + '…' : word
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ' ' + w
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  if (lines.length > max) {
    lines.length = max
    const last = lines[max - 1]
    lines[max - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + '…'
  }
  return lines
}

/** Where Steve sits in a cols x rows pane: his width and height in pixels, his top-left cell. @param {number} cols @param {number} rows */
export function steveBox(cols, rows) {
  // about 60% of the pane's width, as tall as the pane allows (a row for the
  // label under him); three columns on his right for the sound rings
  let w = Math.max(12, Math.min(STEVE_W, Math.round(cols * 0.6)))
  const room = Math.max(4, rows - 2)
  if (Math.ceil((w * STEVE_H) / STEVE_W / 2) > room) w = Math.max(8, Math.floor((room * 2 * STEVE_W) / STEVE_H))
  const h = Math.round((w * STEVE_H) / STEVE_W)
  const x0 = Math.max(0, cols - w - 3)
  const y0 = Math.max(0, rows - 1 - Math.ceil(h / 2))
  return { w, h, x0, y0 }
}

/**
 * The cells of the backdrop for a Raster of cols x rows.
 * @param {number} cols @param {number} rows @param {number} frame @param {SteveState} s
 * @returns {string}
 */
export function steveCells(cols, rows, frame, s) {
  const words = new DataView(new ArrayBuffer(cols * rows * 12))
  for (let i = 0; i < cols * rows; i++) {
    words.setUint32(i * 12, 0x20, true)
    words.setUint32(i * 12 + 4, DEFAULT_COLOR, true)
    words.setUint32(i * 12 + 8, DEFAULT_COLOR, true)
  }
  /** @param {number} x @param {number} y @param {number} cp @param {number} fg */
  const put = (x, y, cp, fg) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return
    const o = (y * cols + x) * 12
    words.setUint32(o, cp, true)
    words.setUint32(o + 4, fg, true)
    words.setUint32(o + 8, DEFAULT_COLOR, true)
  }
  /** @param {number} x @param {number} y @param {string} text @param {number} fg */
  const write = (x, y, text, fg) => {
    for (let i = 0; i < text.length; i++) put(x + i, y, text.charCodeAt(i), fg)
  }

  const { w, h, x0, y0 } = steveBox(cols, rows)
  const px = pixels(s.pose, w, h)
  for (let cy = 0; cy < Math.ceil(h / 2); cy++) {
    for (let x = 0; x < w; x++) {
      const top = px[cy * 2 * w + x]
      const bot = cy * 2 + 1 < h ? px[(cy * 2 + 1) * w + x] : 255
      if (top === 255 && bot === 255) continue
      const X = x0 + x
      const Y = y0 + cy
      if (X >= cols || Y >= rows) continue
      const o = (Y * cols + X) * 12
      if (top !== 255 && bot !== 255) {
        words.setUint32(o, UPPER, true)
        words.setUint32(o + 4, TINT[top], true)
        words.setUint32(o + 8, TINT[bot], true)
      } else if (top !== 255) {
        words.setUint32(o, UPPER, true)
        words.setUint32(o + 4, TINT[top], true)
      } else {
        words.setUint32(o, LOWER, true)
        words.setUint32(o + 4, TINT[bot], true)
      }
    }
  }

  // Sound rings beside his headphones, rippling out while he listens.
  if (s.listening) {
    const ry = y0 + Math.round((h * 0.62) / 2)
    const rx = x0 + w
    const n = 1 + (Math.floor(frame / 3) % 3)
    for (let i = 0; i < n; i++) {
      put(rx + i, ry - 1, 0x2572, RING) // ╲
      put(rx + i, ry, 0x29, RING) // )
      put(rx + i, ry + 1, 0x2571, RING) // ╱
    }
  }

  // The bubble above his head, right-aligned, its tail towards his face.
  const said = narrow(s.bubble ?? '')
  if (said) {
    const maxInner = Math.max(8, Math.min(42, cols - 6))
    const lines = wrap(said, maxInner, 3)
    const inner = Math.max(...lines.map(l => l.length))
    const bw = inner + 4
    // above his head when there is room, else beside it, on his left
    const above = y0 - lines.length - 2 >= 0
    const bx = above ? Math.max(0, Math.min(cols - bw - 1, x0 + Math.round(w * 0.55) - bw + 3)) : Math.max(0, x0 + Math.round(w * 0.2) - bw)
    const by = above ? y0 - lines.length - 2 : Math.min(rows - lines.length - 3, y0 + Math.round(h * 0.12))
    write(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', BORDER)
    lines.forEach((l, i) => {
      put(bx, by + 1 + i, 0x2502, BORDER)
      write(bx + 2, by + 1 + i, l.padEnd(inner), TEXT)
      put(bx + bw - 1, by + 1 + i, 0x2502, BORDER)
    })
    const bottom = by + lines.length + 1
    write(bx, bottom, '╰' + '─'.repeat(bw - 2) + '╯', BORDER)
    if (above) {
      const tx = Math.min(bx + bw - 3, Math.max(bx + 2, x0 + Math.round(w * 0.45)))
      put(tx, bottom, 0x252c, BORDER) // ┬
      if (bottom + 1 < y0 + 1) put(tx, bottom + 1, 0x2502, BORDER)
    } else {
      put(bx + bw - 1, by + 1, 0x251c, BORDER) // ├
      put(bx + bw, by + 1, 0x2500, BORDER) // ─
    }
  }

  // The name and version under him.
  const label = narrow(s.label ?? '').slice(0, cols)
  if (label) write(Math.max(0, Math.min(cols - label.length, x0 + Math.floor((w - label.length) / 2))), rows - 1, label, LABEL)

  return toBase64(new Uint8Array(words.buffer))
}
