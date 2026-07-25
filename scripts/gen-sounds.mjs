// gen-sounds.mjs: offline procedural synthesis of the 'classic' and 'real'
// sound themes for nodechess.
//
//   node scripts/gen-sounds.mjs
//
// Renders 16-bit PCM mono 44.1 kHz WAV files in pure Node (no dependencies;
// WAV headers are written by hand) into:
//
//   src/renderer/src/assets/sounds/classic/<event>.wav        (1 file / event)
//   src/renderer/src/assets/sounds/real/<event>.<1|2|3>.wav   (3 variants / event)
//
// 'classic':   a chess.com-flavored approximation (their actual sounds are
//              proprietary, so nothing is sampled): deep wooden "thock" moves,
//              a heavier double-impact capture, a two-knock castle, a bright
//              alert for check, an ascending chime for promote, a muted buzz
//              for a wrong puzzle move, a dry tick for low time, and a
//              resolved chord for game end.
// 'real'.      Layered wood-on-wood physics: a noise-burst contact transient +
//              a small resonant "piece" mode + inharmonic board-plate modes +
//              a felt-slide tail, with per-variant random micro-variation
//              (pitch/timing/gain jitter) so repeated moves don't sound
//              machine-gun identical. Captures add a sharper crack and a
//              piece-on-piece rattle; game end is a piece laid down and
//              rocking to rest.
//
// Everything is seeded (fnv1a of "theme/event/variant") so re-running the
// script reproduces byte-identical files.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = path.resolve(__dirname, '../src/renderer/src/assets/sounds')

const SR = 44100

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** rng helper: uniform in [lo, hi). */
const uni = (rng, lo, hi) => lo + (hi - lo) * rng()
/** rng helper: multiplicative jitter, e.g. jit(rng, .15) -> x in [0.85, 1.15). */
const jit = (rng, amount) => 1 + (rng() * 2 - 1) * amount

// ---------------------------------------------------------------------------
// DSP primitives (all mix additively into a Float64Array at offset `t` sec)
// ---------------------------------------------------------------------------

function makeBuf(seconds) {
  return new Float64Array(Math.ceil(seconds * SR))
}

/**
 * One exponentially-decaying sine partial: the building block of "modal"
 * synthesis (a struck resonant object is a sum of these).
 *  freq   Hz              tau  decay time constant (s)
 *  gain   linear          t    start offset (s)
 *  attack seconds         drift fractional downward pitch drift as it decays
 */
function mode(out, { t = 0, freq, tau, gain, attack = 0.0012, drift = 0, phase = 0 }) {
  const start = Math.max(0, Math.round(t * SR))
  const len = Math.min(out.length - start, Math.ceil((attack + tau * 7) * SR))
  let ph = phase
  for (let i = 0; i < len; i++) {
    const ts = i / SR
    const env = ts < attack ? ts / attack : Math.exp(-(ts - attack) / tau)
    const f = freq * (1 - drift * (1 - Math.exp(-ts / (tau * 1.5))))
    ph += (2 * Math.PI * f) / SR
    out[start + i] += Math.sin(ph) * gain * env
  }
}

/** RBJ biquad filter over an array (in place). type: 'bandpass' | 'lowpass' | 'highpass'. */
function biquad(x, type, f0, q) {
  const w0 = (2 * Math.PI * f0) / SR
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const alpha = sw / (2 * q)
  let b0, b1, b2
  if (type === 'bandpass') {
    // constant 0 dB peak gain
    b0 = alpha
    b1 = 0
    b2 = -alpha
  } else if (type === 'lowpass') {
    b0 = (1 - cw) / 2
    b1 = 1 - cw
    b2 = (1 - cw) / 2
  } else {
    b0 = (1 + cw) / 2
    b1 = -(1 + cw)
    b2 = (1 + cw) / 2
  }
  const a0 = 1 + alpha
  const a1 = -2 * cw
  const a2 = 1 - alpha
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    const yi = (b0 / a0) * xi + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
    x2 = x1
    x1 = xi
    y2 = y1
    y1 = yi
    x[i] = yi
  }
}

/**
 * Band-passed white-noise burst: the contact "click" of wood meeting wood.
 *  dur    total seconds     center/q  bandpass shape
 *  decay  env time constant (defaults to dur/3)
 */
function noiseBurst(out, rng, { t = 0, dur, center, q = 0.9, gain, attack = 0.0003, decay }) {
  const n = Math.ceil(dur * SR)
  const tmp = new Float64Array(n)
  for (let i = 0; i < n; i++) tmp[i] = rng() * 2 - 1
  biquad(tmp, 'bandpass', center, q)
  const tc = decay ?? dur / 3
  const start = Math.max(0, Math.round(t * SR))
  for (let i = 0; i < n && start + i < out.length; i++) {
    const ts = i / SR
    const env = ts < attack ? ts / attack : Math.exp(-(ts - attack) / tc)
    out[start + i] += tmp[i] * gain * env
  }
}

/**
 * Felt-slide / scuff: low-passed noise with a slow swell-and-fade envelope.
 * Reads as a piece's felt base sliding/settling on the board.
 */
function slide(out, rng, { t = 0, dur, cutoff = 1100, gain, swell = 0.35 }) {
  const n = Math.ceil(dur * SR)
  const tmp = new Float64Array(n)
  for (let i = 0; i < n; i++) tmp[i] = rng() * 2 - 1
  biquad(tmp, 'lowpass', cutoff, 0.7)
  biquad(tmp, 'highpass', 180, 0.7) // keep the scuff airy, not rumbly
  const start = Math.max(0, Math.round(t * SR))
  const peakAt = Math.max(1, Math.floor(n * swell))
  for (let i = 0; i < n && start + i < out.length; i++) {
    const env = i < peakAt ? i / peakAt : (n - i) / (n - peakAt)
    out[start + i] += tmp[i] * gain * env * env
  }
}

// ---------------------------------------------------------------------------
// Composite gestures
// ---------------------------------------------------------------------------

/**
 * A wooden knock for the 'classic' theme: clean and repeatable (no rng in the
 * partial structure; classic is one fixed file per event).
 *  f0     body fundamental (Hz)   weight  scales gains / darkens
 *  click  transient gain          bright  scales click center + upper modes
 */
function knockC(out, rng, { t = 0, f0, weight = 1, click = 0.45, bright = 1, tau = 0.045 }) {
  noiseBurst(out, rng, {
    t,
    dur: 0.004,
    center: 2500 * bright,
    q: 0.8,
    gain: click,
    decay: 0.0022
  })
  mode(out, { t, freq: f0, tau, gain: 1.0 * weight, attack: 0.002, drift: 0.06 })
  mode(out, { t, freq: f0 * 1.52, tau: tau * 0.55, gain: 0.42 * weight, attack: 0.002 })
  mode(out, { t, freq: f0 * 2.2, tau: tau * 0.34, gain: 0.22 * weight * bright, attack: 0.0015 })
  mode(out, { t, freq: f0 * 0.5, tau: tau * 1.1, gain: 0.34 * weight, attack: 0.003 })
}

/** A chime/marimba note for 'classic' melodic cues (promote, start/end, solved). */
function chimeC(out, rng, { t = 0, freq, tau = 0.12, gain = 0.8, woody = 0.2 }) {
  mode(out, { t, freq, tau, gain, attack: 0.003 })
  mode(out, { t, freq: freq * 2.01, tau: tau * 0.5, gain: gain * 0.28, attack: 0.003 })
  mode(out, { t, freq: freq * 4.2, tau: tau * 0.22, gain: gain * 0.1, attack: 0.002 })
  if (woody > 0) {
    noiseBurst(out, rng, { t, dur: 0.003, center: 2200, q: 1, gain: woody, decay: 0.0015 })
  }
}

/**
 * A physical piece placement for the 'real' theme. Every call re-rolls the
 * micro-structure from `rng`, so each variant (and each event) breathes.
 *  weight     how heavy the piece lands (gain + low bias)
 *  brightness contact hardness (click level/center, upper-mode level)
 *  board      board-plate fundamental (Hz)
 *  ring       scales decay times (bigger = more resonant)
 */
function placement(out, rng, { t = 0, weight = 1, brightness = 1, board = 150, ring = 1 }) {
  // 1) contact transient, 1.5–3 ms of band-passed noise
  noiseBurst(out, rng, {
    t,
    dur: uni(rng, 0.0015, 0.003),
    center: (2100 + 2100 * brightness) * jit(rng, 0.18),
    q: uni(rng, 0.7, 1.1),
    gain: 0.42 * weight * brightness * jit(rng, 0.25),
    decay: uni(rng, 0.0012, 0.0024)
  })
  // 2) the piece itself: one small, quickly-damped mode
  mode(out, {
    t,
    freq: uni(rng, 480, 880) * brightness,
    tau: uni(rng, 0.009, 0.018) * ring,
    gain: 0.34 * weight * jit(rng, 0.3),
    attack: 0.0012,
    phase: rng() * 6.28
  })
  // 3) board plate: inharmonic mode stack (wood plates aren't harmonic)
  const f0 = board * jit(rng, 0.05)
  const ratios = [1, 1.62 * jit(rng, 0.06), 2.36 * jit(rng, 0.08), 3.4 * jit(rng, 0.1)]
  const taus = [0.055, 0.03, 0.019, 0.012]
  const gains = [1, 0.5, 0.3 * brightness, 0.17 * brightness]
  for (let m = 0; m < ratios.length; m++) {
    mode(out, {
      t: t + (m === 0 ? 0 : uni(rng, 0, 0.0012)), // sub-ms mode onset scatter
      freq: f0 * ratios[m],
      tau: taus[m] * ring * jit(rng, 0.2),
      gain: gains[m] * weight * jit(rng, 0.2),
      attack: 0.0018,
      drift: 0.05,
      phase: rng() * 6.28
    })
  }
  // 4) a whisper of low "table" weight
  mode(out, {
    t,
    freq: f0 * 0.52,
    tau: 0.06 * ring,
    gain: 0.3 * weight * jit(rng, 0.2),
    attack: 0.003,
    phase: rng() * 6.28
  })
}

/** Captured-piece rattle: a few fast, decaying piece-on-piece micro-knocks. */
function rattle(out, rng, { t = 0, count = 3, gain = 0.5 }) {
  let at = t
  let g = gain
  for (let i = 0; i < count; i++) {
    at += uni(rng, 0.012, 0.028) * (1 - i * 0.12) // knocks bunch up as they die
    const f = uni(rng, 620, 1500)
    mode(out, { t: at, freq: f, tau: uni(rng, 0.006, 0.013), gain: g * jit(rng, 0.3), attack: 0.0008 })
    noiseBurst(out, rng, { t: at, dur: 0.0012, center: f * 2.4, q: 1, gain: g * 0.5, decay: 0.0008 })
    g *= 0.62
  }
}

// ---------------------------------------------------------------------------
// Post-processing + WAV writer
// ---------------------------------------------------------------------------

/** One-pole high-pass (~28 Hz) to strip DC, normalize to `peak`, fade edges. */
function finalize(x, peak) {
  const rc = 1 / (2 * Math.PI * 28)
  const a = rc / (rc + 1 / SR)
  let prevX = 0
  let prevY = 0
  for (let i = 0; i < x.length; i++) {
    const y = a * (prevY + x[i] - prevX)
    prevX = x[i]
    prevY = y
    x[i] = y
  }
  let max = 1e-9
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]))
  const k = peak / max
  for (let i = 0; i < x.length; i++) x[i] *= k
  const fadeIn = Math.min(x.length, Math.round(0.0004 * SR))
  for (let i = 0; i < fadeIn; i++) x[i] *= i / fadeIn
  const fadeOut = Math.min(x.length, Math.round(0.008 * SR))
  for (let i = 0; i < fadeOut; i++) x[x.length - 1 - i] *= i / fadeOut
  return x
}

function wavBytes(x) {
  const n = x.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits/sample
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, x[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

// ---------------------------------------------------------------------------
// CLASSIC theme, chess.com-flavored, one fixed render per event
// ---------------------------------------------------------------------------

const CLASSIC = {
  // Signature deep wooden "thock": ~2 ms attack, low-mid body, click transient.
  move(out, rng) {
    knockC(out, rng, { f0: 185, weight: 1, click: 0.5, bright: 1, tau: 0.048 })
  },
  // Heavier double impact: a snap, then the deep landing.
  capture(out, rng) {
    knockC(out, rng, { t: 0, f0: 208, weight: 0.8, click: 0.62, bright: 1.25, tau: 0.03 })
    knockC(out, rng, { t: 0.048, f0: 132, weight: 1.2, click: 0.36, bright: 0.85, tau: 0.06 })
  },
  // Two knocks: king, then rook settling.
  castle(out, rng) {
    knockC(out, rng, { t: 0, f0: 212, weight: 0.9, click: 0.42, tau: 0.04 })
    knockC(out, rng, { t: 0.12, f0: 166, weight: 1.05, click: 0.34, tau: 0.052 })
  },
  // Bright, short alert: a small bell over a grounding knock.
  check(out, rng) {
    mode(out, { t: 0, freq: 1046, tau: 0.1, gain: 0.95, attack: 0.002 })
    mode(out, { t: 0, freq: 2093, tau: 0.05, gain: 0.36, attack: 0.002 })
    mode(out, { t: 0, freq: 3135, tau: 0.028, gain: 0.16, attack: 0.0015 })
    knockC(out, rng, { t: 0, f0: 205, weight: 0.5, click: 0.3, tau: 0.028 })
  },
  // Ascending chime: E5 G5 C6 with a sparkle on top.
  promote(out, rng) {
    chimeC(out, rng, { t: 0, freq: 659, tau: 0.11, gain: 0.72, woody: 0.16 })
    chimeC(out, rng, { t: 0.085, freq: 784, tau: 0.11, gain: 0.76, woody: 0.14 })
    chimeC(out, rng, { t: 0.17, freq: 1047, tau: 0.17, gain: 0.82, woody: 0.12 })
    mode(out, { t: 0.17, freq: 2093, tau: 0.09, gain: 0.14, attack: 0.003 })
  },
  // Warm two-note rise: pieces are set, the game is on.
  gameStart(out, rng) {
    chimeC(out, rng, { t: 0, freq: 330, tau: 0.12, gain: 0.85, woody: 0.22 })
    chimeC(out, rng, { t: 0.13, freq: 440, tau: 0.15, gain: 0.9, woody: 0.18 })
  },
  // Resolved chord: a settled C-major roll, gently damped.
  gameEnd(out, rng) {
    chimeC(out, rng, { t: 0, freq: 262, tau: 0.26, gain: 0.85, woody: 0.2 })
    chimeC(out, rng, { t: 0.014, freq: 330, tau: 0.24, gain: 0.62, woody: 0 })
    chimeC(out, rng, { t: 0.028, freq: 392, tau: 0.22, gain: 0.56, woody: 0 })
    chimeC(out, rng, { t: 0.042, freq: 523, tau: 0.2, gain: 0.44, woody: 0 })
  },
  // Dry clock tick.
  lowTime(out, rng) {
    mode(out, { t: 0, freq: 1150, tau: 0.013, gain: 0.85, attack: 0.0008 })
    noiseBurst(out, rng, { t: 0, dur: 0.002, center: 3400, q: 1, gain: 0.5, decay: 0.001 })
  },
  // Bright little "ding-ding", correct!
  puzzleSolved(out, rng) {
    chimeC(out, rng, { t: 0, freq: 784, tau: 0.09, gain: 0.7, woody: 0.1 })
    chimeC(out, rng, { t: 0.1, freq: 1047, tau: 0.14, gain: 0.8, woody: 0.08 })
  },
  // Muted buzz: soft, unpunishing "nope" (doubles as an illegal-move cue).
  puzzleFailed(out) {
    const n = Math.ceil(0.24 * SR)
    for (let i = 0; i < n && i < out.length; i++) {
      const ts = i / SR
      const env = (ts < 0.006 ? ts / 0.006 : Math.exp(-(ts - 0.006) / 0.085)) *
        (0.72 + 0.28 * Math.sin(2 * Math.PI * 29 * ts)) // tremolo = "buzz"
      const w =
        Math.sin(2 * Math.PI * 118 * ts) +
        0.5 * Math.sin(2 * Math.PI * 118 * 3 * ts) +
        0.24 * Math.sin(2 * Math.PI * 118 * 5 * ts)
      out[i] += w * env * 0.8
    }
    biquad(out, 'lowpass', 620, 0.8) // keep it muted
  }
}

/** duration (s) + normalization peak per classic event. */
const CLASSIC_SPEC = {
  move: [0.13, 0.8],
  capture: [0.2, 0.88],
  castle: [0.26, 0.8],
  check: [0.3, 0.7],
  promote: [0.48, 0.7],
  gameStart: [0.4, 0.68],
  gameEnd: [0.68, 0.7],
  lowTime: [0.055, 0.66],
  puzzleSolved: [0.34, 0.66],
  puzzleFailed: [0.26, 0.6]
}

// ---------------------------------------------------------------------------
// REAL theme: wood physics, 3 seeded variants per event
// ---------------------------------------------------------------------------

const REAL = {
  // A quiet move: soft contact, felt-slide settle.
  move(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 0.85, 1), brightness: uni(rng, 0.75, 0.95), board: 148, ring: jit(rng, 0.12) })
    slide(out, rng, { t: uni(rng, 0.018, 0.03), dur: uni(rng, 0.05, 0.085), cutoff: uni(rng, 900, 1300), gain: uni(rng, 0.05, 0.09) })
  },
  // Sharper crack + the taken piece rattling against the taker.
  capture(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 1.05, 1.25), brightness: uni(rng, 1.25, 1.5), board: 140, ring: jit(rng, 0.12) })
    rattle(out, rng, { t: 0.012, count: 3 + (rng() < 0.5 ? 1 : 0), gain: uni(rng, 0.4, 0.55) })
    slide(out, rng, { t: uni(rng, 0.08, 0.11), dur: uni(rng, 0.04, 0.06), cutoff: 1100, gain: uni(rng, 0.04, 0.07) })
  },
  // Two placements: king first, rook a beat later, then everything settles.
  castle(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 0.8, 0.95), brightness: uni(rng, 0.85, 1), board: 156, ring: jit(rng, 0.1) })
    const t2 = uni(rng, 0.125, 0.165)
    placement(out, rng, { t: t2, weight: uni(rng, 0.95, 1.15), brightness: uni(rng, 0.8, 0.95), board: 138, ring: jit(rng, 0.1) })
    slide(out, rng, { t: t2 + 0.02, dur: uni(rng, 0.05, 0.08), cutoff: 1000, gain: uni(rng, 0.05, 0.08) })
  },
  // A firm, assertive set-down: brighter, ringier, with a knuckly double-tap.
  check(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 1.1, 1.3), brightness: uni(rng, 1.05, 1.25), board: 162, ring: 1.3 * jit(rng, 0.1) })
    mode(out, { t: uni(rng, 0.028, 0.038), freq: uni(rng, 520, 640), tau: 0.014, gain: 0.3, attack: 0.001, phase: rng() * 6.28 })
  },
  // Pawn scuffed off, queen set down with authority, tiny settle tap.
  promote(out, rng) {
    slide(out, rng, { t: 0, dur: uni(rng, 0.05, 0.07), cutoff: 1200, gain: uni(rng, 0.07, 0.1), swell: 0.5 })
    placement(out, rng, { t: uni(rng, 0.065, 0.085), weight: uni(rng, 1.05, 1.2), brightness: uni(rng, 1, 1.2), board: 158, ring: 1.3 })
    mode(out, { t: uni(rng, 0.18, 0.21), freq: uni(rng, 640, 760), tau: 0.012, gain: 0.22, attack: 0.001, phase: rng() * 6.28 })
  },
  // Last two pieces placed gently: the board is set.
  gameStart(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 0.6, 0.75), brightness: 0.8, board: 150, ring: jit(rng, 0.1) })
    slide(out, rng, { t: 0.03, dur: 0.06, cutoff: 1100, gain: 0.05 })
    placement(out, rng, { t: uni(rng, 0.16, 0.2), weight: uni(rng, 0.7, 0.85), brightness: 0.85, board: 162, ring: jit(rng, 0.1) })
    slide(out, rng, { t: uni(rng, 0.2, 0.24), dur: 0.07, cutoff: 1000, gain: 0.05 })
  },
  // The king is laid down and rocks to rest, knock, wobble-wobble, hush.
  gameEnd(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 1.15, 1.35), brightness: uni(rng, 0.85, 1), board: 134, ring: jit(rng, 0.1) })
    let at = uni(rng, 0.1, 0.13)
    let gap = uni(rng, 0.08, 0.095)
    let g = 0.42
    for (let i = 0; i < 6 && at < 0.46; i++) {
      const f = uni(rng, 380, 520) + i * 26 // rocking gets smaller + slightly higher
      mode(out, { t: at, freq: f, tau: uni(rng, 0.012, 0.02), gain: g * jit(rng, 0.25), attack: 0.001, phase: rng() * 6.28 })
      noiseBurst(out, rng, { t: at, dur: 0.0012, center: 2400, q: 1, gain: g * 0.4, decay: 0.0008 })
      at += gap
      gap *= 0.72 // rocking accelerates as it dies out
      g *= 0.68
    }
    slide(out, rng, { t: 0.4, dur: 0.09, cutoff: 900, gain: 0.045, swell: 0.4 })
  },
  // A mechanical clock tick: nothing but escapement.
  lowTime(out, rng) {
    noiseBurst(out, rng, { t: 0, dur: 0.0015, center: uni(rng, 2600, 3100), q: 1.1, gain: 0.6, decay: 0.0008 })
    mode(out, { t: 0, freq: uni(rng, 1400, 1600), tau: 0.007, gain: 0.5, attack: 0.0006, phase: rng() * 6.28 })
    mode(out, { t: 0, freq: uni(rng, 680, 760), tau: 0.01, gain: 0.2, attack: 0.0008, phase: rng() * 6.28 })
  },
  // Two confident rising raps on the board, "well played".
  puzzleSolved(out, rng) {
    placement(out, rng, { t: 0, weight: 0.8, brightness: 1.15, board: 176, ring: 1.2 })
    placement(out, rng, { t: uni(rng, 0.11, 0.13), weight: 0.9, brightness: 1.25, board: 212, ring: 1.35 })
  },
  // A piece put down flat and dull. Muffled thud + resigned little scuff.
  puzzleFailed(out, rng) {
    placement(out, rng, { t: 0, weight: uni(rng, 1.1, 1.3), brightness: uni(rng, 0.4, 0.5), board: 106, ring: 0.62 })
    slide(out, rng, { t: 0.05, dur: uni(rng, 0.08, 0.11), cutoff: 800, gain: uni(rng, 0.09, 0.12), swell: 0.3 })
  }
}

const REAL_SPEC = {
  move: [0.16, 0.68],
  capture: [0.23, 0.88],
  castle: [0.34, 0.76],
  check: [0.2, 0.82],
  promote: [0.3, 0.78],
  gameStart: [0.42, 0.6],
  gameEnd: [0.58, 0.78],
  lowTime: [0.05, 0.55],
  puzzleSolved: [0.3, 0.7],
  puzzleFailed: [0.26, 0.64]
}

const REAL_VARIANTS = 3

// ---------------------------------------------------------------------------
// Render everything
// ---------------------------------------------------------------------------

async function renderTheme(theme, builders, specs, variants) {
  const dir = path.join(OUT_ROOT, theme)
  await mkdir(dir, { recursive: true })
  let files = 0
  let bytes = 0
  for (const [event, build] of Object.entries(builders)) {
    const [dur, peak] = specs[event]
    for (let v = 1; v <= variants; v++) {
      const rng = mulberry32(fnv1a(`${theme}/${event}/${v}`))
      const out = makeBuf(dur)
      build(out, rng)
      finalize(out, peak)
      const name = variants > 1 ? `${event}.${v}.wav` : `${event}.wav`
      const wav = wavBytes(out)
      await writeFile(path.join(dir, name), wav)
      files++
      bytes += wav.length
    }
  }
  console.log(`${theme}: ${files} files, ${(bytes / 1024).toFixed(1)} KiB`)
  return bytes
}

async function main() {
  const c = await renderTheme('classic', CLASSIC, CLASSIC_SPEC, 1)
  const r = await renderTheme('real', REAL, REAL_SPEC, REAL_VARIANTS)
  const total = c + r
  console.log(`generated total: ${(total / 1024).toFixed(1)} KiB`)
  if (total > 1.2 * 1024 * 1024) {
    console.warn('WARNING: generated assets exceed the 1.2 MiB self-budget, trim durations.')
  }
}

main().catch((err) => {
  console.error('gen-sounds failed:', err)
  process.exitCode = 1
})
