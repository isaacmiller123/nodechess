// gen-game-sounds.mjs: offline procedural synthesis of the GAMES-PLATFORM
// sound events for nodechess (docs/GAMES-PLATFORM-SPEC.md).
//
//   node scripts/gen-game-sounds.mjs
//
// Renders 16-bit PCM mono 44.1 kHz WAV files in pure Node (no dependencies;
// WAV headers written by hand) into:
//
//   src/renderer/src/assets/sounds/games/<event>.<1|2|3>.wav   (3 variants)
//   src/renderer/src/assets/sounds/games/gameStartGong.wav     (1 take)
//
// The games/ directory is a THEME-AGNOSTIC pool: SoundManager serves these
// samples for every theme (standard/classic/real) unless a theme dir ships
// its own file for the event, so per-theme overrides need zero code.
//
// Events (all physically layered: noise-burst contact transients + tuned
// modal resonances + exponential decays; every variant re-rolls seeded
// micro-variation so rapid play never machine-guns one take):
//   goStone           slate stone snapped onto a kaya goban, glassy click,
//                     deep resonant board 'pok' (goban cavity)
//   discFlip          othello disc flipping: quick light double-click flutter
//   discPlace         felt-damped wooden disc tap (checkers/morris)
//   discDrop          connect-4: disc chattering down the slot rails,
//                     accelerating + descending, then a plastic landing clack
//   pieceSlideCapture checkers jump: felt swoosh, landing tap, taken-piece
//                     rattle
//   penStroke         soft marker squeak on paper (tic-tac-toe/hex)
//   shogiPiece        shogi wedge snapped down ("pachi"): sharper and
//                     brighter than the western chess move
//   gameStartGong     subtle low gong swell (go game start)
//
// Everything is seeded (fnv1a of "games/event/variant") so re-running the
// script reproduces byte-identical files. DSP primitives mirror
// scripts/gen-sounds.mjs (kept self-contained per script, like that file).
// Verify output with: node scripts/check-game-sounds.mjs

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../src/renderer/src/assets/sounds/games')

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

/** One exponentially-decaying sine partial (modal synthesis building block). */
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

/** RBJ biquad over an array (in place). type: 'bandpass' | 'lowpass' | 'highpass'. */
function biquad(x, type, f0, q) {
  const w0 = (2 * Math.PI * f0) / SR
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const alpha = sw / (2 * q)
  let b0, b1, b2
  if (type === 'bandpass') {
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

/** Band-passed white-noise burst: the contact "click" of two hard surfaces. */
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

/** Felt-slide / scuff: low-passed noise with a swell-and-fade envelope. */
function slide(out, rng, { t = 0, dur, cutoff = 1100, gain, swell = 0.35 }) {
  const n = Math.ceil(dur * SR)
  const tmp = new Float64Array(n)
  for (let i = 0; i < n; i++) tmp[i] = rng() * 2 - 1
  biquad(tmp, 'lowpass', cutoff, 0.7)
  biquad(tmp, 'highpass', 180, 0.7)
  const start = Math.max(0, Math.round(t * SR))
  const peakAt = Math.max(1, Math.floor(n * swell))
  for (let i = 0; i < n && start + i < out.length; i++) {
    const env = i < peakAt ? i / peakAt : (n - i) / (n - peakAt)
    out[start + i] += tmp[i] * gain * env * env
  }
}

/** Band-emphasized stroke noise: marker/pen on paper (bandpass, swell env). */
function stroke(out, rng, { t = 0, dur, center = 1700, q = 1.6, gain, swell = 0.4 }) {
  const n = Math.ceil(dur * SR)
  const tmp = new Float64Array(n)
  for (let i = 0; i < n; i++) tmp[i] = rng() * 2 - 1
  biquad(tmp, 'bandpass', center, q)
  biquad(tmp, 'highpass', 500, 0.7)
  const start = Math.max(0, Math.round(t * SR))
  const peakAt = Math.max(1, Math.floor(n * swell))
  for (let i = 0; i < n && start + i < out.length; i++) {
    const env = i < peakAt ? i / peakAt : (n - i) / (n - peakAt)
    out[start + i] += tmp[i] * gain * env
  }
}

/**
 * A physical piece placement (as in gen-sounds.mjs 'real'): contact transient
 * + one small piece mode + inharmonic board-plate mode stack + low weight.
 */
function placement(out, rng, { t = 0, weight = 1, brightness = 1, board = 150, ring = 1 }) {
  noiseBurst(out, rng, {
    t,
    dur: uni(rng, 0.0015, 0.003),
    center: (2100 + 2100 * brightness) * jit(rng, 0.18),
    q: uni(rng, 0.7, 1.1),
    gain: 0.42 * weight * brightness * jit(rng, 0.25),
    decay: uni(rng, 0.0012, 0.0024)
  })
  mode(out, {
    t,
    freq: uni(rng, 480, 880) * brightness,
    tau: uni(rng, 0.009, 0.018) * ring,
    gain: 0.34 * weight * jit(rng, 0.3),
    attack: 0.0012,
    phase: rng() * 6.28
  })
  const f0 = board * jit(rng, 0.05)
  const ratios = [1, 1.62 * jit(rng, 0.06), 2.36 * jit(rng, 0.08), 3.4 * jit(rng, 0.1)]
  const taus = [0.055, 0.03, 0.019, 0.012]
  const gains = [1, 0.5, 0.3 * brightness, 0.17 * brightness]
  for (let m = 0; m < ratios.length; m++) {
    mode(out, {
      t: t + (m === 0 ? 0 : uni(rng, 0, 0.0012)),
      freq: f0 * ratios[m],
      tau: taus[m] * ring * jit(rng, 0.2),
      gain: gains[m] * weight * jit(rng, 0.2),
      attack: 0.0018,
      drift: 0.05,
      phase: rng() * 6.28
    })
  }
  mode(out, {
    t,
    freq: f0 * 0.52,
    tau: 0.06 * ring,
    gain: 0.3 * weight * jit(rng, 0.2),
    attack: 0.003,
    phase: rng() * 6.28
  })
}

/** A few fast, decaying piece-on-piece micro-knocks. */
function rattle(out, rng, { t = 0, count = 3, gain = 0.5 }) {
  let at = t
  let g = gain
  for (let i = 0; i < count; i++) {
    at += uni(rng, 0.012, 0.028) * (1 - i * 0.12)
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
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, x[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

// ---------------------------------------------------------------------------
// Event builders: every call re-rolls seeded micro-structure from `rng`
// ---------------------------------------------------------------------------

const GAMES = {
  // Slate stone snapped onto a kaya goban. Signature: a hard glassy contact
  // (stone is much harder than boxwood) over the goban's deep cavity 'pok':
  // traditional boards are hollowed underneath and genuinely resonant.
  goStone(out, rng) {
    // contact snap: very bright, ~1–2 ms
    noiseBurst(out, rng, {
      t: 0,
      dur: uni(rng, 0.001, 0.002),
      center: uni(rng, 4200, 5200),
      q: 0.85,
      gain: uni(rng, 0.5, 0.62),
      decay: 0.0009
    })
    // stone modes. Glassy, very quickly damped
    mode(out, { t: 0, freq: uni(rng, 2600, 3200), tau: uni(rng, 0.004, 0.007), gain: 0.4 * jit(rng, 0.2), attack: 0.0006, phase: rng() * 6.28 })
    mode(out, { t: 0, freq: uni(rng, 4200, 5000), tau: uni(rng, 0.003, 0.005), gain: 0.22 * jit(rng, 0.25), attack: 0.0005, phase: rng() * 6.28 })
    // goban cavity: the deep 'pok' that makes go sound like go
    const f0 = 218 * jit(rng, 0.05)
    mode(out, { t: 0.0008, freq: f0, tau: uni(rng, 0.05, 0.07), gain: 1.0, attack: 0.0015, drift: 0.05, phase: rng() * 6.28 })
    mode(out, { t: 0.0008, freq: f0 * 1.58 * jit(rng, 0.04), tau: 0.03 * jit(rng, 0.15), gain: 0.42, attack: 0.0015, phase: rng() * 6.28 })
    mode(out, { t: 0.001, freq: f0 * 2.4 * jit(rng, 0.06), tau: 0.018 * jit(rng, 0.15), gain: 0.25, attack: 0.001, phase: rng() * 6.28 })
    // floor weight under the board's legs
    mode(out, { t: 0, freq: f0 * 0.5, tau: 0.07, gain: 0.3 * jit(rng, 0.2), attack: 0.003, phase: rng() * 6.28 })
  },

  // Othello disc flipping over: a light tick as it lifts, a slightly deeper
  // tap as the other face lands, and a tiny settle: a double-click flutter.
  discFlip(out, rng) {
    const t2 = uni(rng, 0.028, 0.042)
    // face lifts. Light plastic tick
    noiseBurst(out, rng, { t: 0, dur: 0.0012, center: uni(rng, 2900, 3500), q: 1, gain: uni(rng, 0.3, 0.4), decay: 0.0007 })
    mode(out, { t: 0, freq: uni(rng, 1300, 1600), tau: uni(rng, 0.005, 0.008), gain: 0.4 * jit(rng, 0.2), attack: 0.0006, phase: rng() * 6.28 })
    // lands on the opposite face. Slightly deeper
    noiseBurst(out, rng, { t: t2, dur: 0.0015, center: uni(rng, 2300, 2800), q: 1, gain: uni(rng, 0.36, 0.48), decay: 0.0009 })
    mode(out, { t: t2, freq: uni(rng, 900, 1100), tau: uni(rng, 0.008, 0.012), gain: 0.55 * jit(rng, 0.2), attack: 0.0008, phase: rng() * 6.28 })
    mode(out, { t: t2, freq: 236 * jit(rng, 0.06), tau: uni(rng, 0.025, 0.035), gain: 0.5, attack: 0.0015, drift: 0.05, phase: rng() * 6.28 })
    // tiny settle wobble
    mode(out, { t: t2 + uni(rng, 0.02, 0.032), freq: uni(rng, 1000, 1250), tau: 0.004, gain: 0.16 * jit(rng, 0.3), attack: 0.0007, phase: rng() * 6.28 })
  },

  // Felt-damped wooden disc tap, checkers/morris. Duller and rounder than a
  // chess piece: low contact brightness, tight ring, a whisper of felt.
  discPlace(out, rng) {
    placement(out, rng, {
      t: 0,
      weight: uni(rng, 0.9, 1.05),
      brightness: uni(rng, 0.5, 0.65),
      board: 132,
      ring: 0.8 * jit(rng, 0.1)
    })
    slide(out, rng, { t: uni(rng, 0.016, 0.026), dur: uni(rng, 0.04, 0.06), cutoff: uni(rng, 700, 900), gain: uni(rng, 0.05, 0.08) })
  },

  // Connect-4 drop. The disc chatters down the slot rails (accelerating,
  // descending ticks), lands with a hollow plastic clack into the frame,
  // then one small bounce.
  discDrop(out, rng) {
    let at = 0
    let f = uni(rng, 1900, 2250)
    let gap = uni(rng, 0.052, 0.062)
    let g = uni(rng, 0.26, 0.32)
    for (let i = 0; i < 5; i++) {
      noiseBurst(out, rng, { t: at, dur: 0.0012, center: Math.min(f * 1.9, 9000), q: 1, gain: g * 0.5, decay: 0.0007 })
      mode(out, { t: at, freq: f * jit(rng, 0.06), tau: uni(rng, 0.004, 0.006), gain: g * jit(rng, 0.2), attack: 0.0006, phase: rng() * 6.28 })
      at += gap
      gap *= 0.82 // gravity: hits come faster
      f *= 0.88 // and lower as it nears the bottom
      g *= 1.09 // and a touch louder
    }
    // landing clack. Hollow plastic disc into the stack/frame
    noiseBurst(out, rng, { t: at, dur: 0.002, center: uni(rng, 2700, 3300), q: 0.9, gain: uni(rng, 0.5, 0.6), decay: 0.0012 })
    mode(out, { t: at, freq: uni(rng, 700, 850), tau: uni(rng, 0.012, 0.017), gain: 0.8, attack: 0.0008, phase: rng() * 6.28 })
    mode(out, { t: at, freq: uni(rng, 1400, 1700), tau: 0.007, gain: 0.3, attack: 0.0007, phase: rng() * 6.28 })
    mode(out, { t: at, freq: 172 * jit(rng, 0.06), tau: uni(rng, 0.04, 0.055), gain: 0.7, attack: 0.002, drift: 0.05, phase: rng() * 6.28 }) // frame body
    // one small bounce
    const tb = at + uni(rng, 0.05, 0.068)
    mode(out, { t: tb, freq: uni(rng, 750, 900), tau: 0.008, gain: 0.28 * jit(rng, 0.25), attack: 0.0008, phase: rng() * 6.28 })
    noiseBurst(out, rng, { t: tb, dur: 0.001, center: 3000, q: 1, gain: 0.14, decay: 0.0006 })
  },

  // Checkers jump: the piece swooshes over the taken one (felt slide with a
  // swell), lands with a wooden tap, and the captured piece rattles aside.
  pieceSlideCapture(out, rng) {
    const land = uni(rng, 0.1, 0.125)
    slide(out, rng, {
      t: 0,
      dur: land + uni(rng, 0.01, 0.02),
      cutoff: uni(rng, 1400, 1800),
      gain: uni(rng, 0.15, 0.2),
      swell: 0.45
    })
    placement(out, rng, {
      t: land,
      weight: uni(rng, 0.85, 1),
      brightness: uni(rng, 0.7, 0.85),
      board: 140,
      ring: 0.9 * jit(rng, 0.1)
    })
    rattle(out, rng, { t: land + uni(rng, 0.015, 0.025), count: 2, gain: uni(rng, 0.26, 0.34) })
  },

  // Soft marker squeak: tic-tac-toe / hex. Mostly band-emphasized stroke
  // hiss with a faint gliding squeak resonance and a tiny pen-lift tick.
  penStroke(out, rng) {
    const dur = uni(rng, 0.11, 0.15)
    stroke(out, rng, { t: 0, dur, center: uni(rng, 1500, 2000), q: uni(rng, 1.4, 1.9), gain: uni(rng, 0.5, 0.62), swell: uni(rng, 0.3, 0.5) })
    // felt-tip squeak. Quiet, slightly falling
    mode(out, { t: dur * 0.15, freq: uni(rng, 1500, 1900), tau: dur * 0.45, gain: uni(rng, 0.1, 0.16), attack: dur * 0.25, drift: 0.12, phase: rng() * 6.28 })
    // pen lifts off the board
    noiseBurst(out, rng, { t: dur * uni(rng, 0.92, 1), dur: 0.001, center: 2800, q: 1, gain: 0.12, decay: 0.0006 })
  },

  // Shogi wedge snapped onto the board: the famous "pachi": a fingertip
  // drive, a hard dry boxwood crack (higher than a western piece), and a
  // tight, punchy board note (shogi boards are thick and legged, like goban).
  shogiPiece(out, rng) {
    // fingertip snap: extremely bright, ~1.5 ms
    noiseBurst(out, rng, {
      t: 0,
      dur: uni(rng, 0.001, 0.0018),
      center: uni(rng, 4800, 5800),
      q: 0.8,
      gain: uni(rng, 0.52, 0.64),
      decay: 0.0008
    })
    // wedge modes. Hard, dry, high
    mode(out, { t: 0, freq: uni(rng, 1500, 1900), tau: uni(rng, 0.006, 0.01), gain: 0.55 * jit(rng, 0.2), attack: 0.0006, phase: rng() * 6.28 })
    mode(out, { t: 0, freq: uni(rng, 3000, 3600), tau: uni(rng, 0.003, 0.005), gain: 0.28 * jit(rng, 0.25), attack: 0.0005, phase: rng() * 6.28 })
    // board: deep but tighter/faster than the goban 'pok'
    const f0 = 196 * jit(rng, 0.05)
    mode(out, { t: 0.0008, freq: f0, tau: uni(rng, 0.042, 0.055), gain: 1.0, attack: 0.0014, drift: 0.06, phase: rng() * 6.28 })
    mode(out, { t: 0.0008, freq: f0 * 1.55 * jit(rng, 0.05), tau: 0.024 * jit(rng, 0.15), gain: 0.4, attack: 0.0014, phase: rng() * 6.28 })
    mode(out, { t: 0.001, freq: f0 * 2.3 * jit(rng, 0.06), tau: 0.015 * jit(rng, 0.15), gain: 0.26, attack: 0.001, phase: rng() * 6.28 })
    mode(out, { t: 0, freq: f0 * 0.5, tau: 0.055, gain: 0.26 * jit(rng, 0.2), attack: 0.003, phase: rng() * 6.28 })
  },

  // Subtle low gong for a go game start. Soft mallet, inharmonic metal
  // partials with a slight beating shimmer, long gentle decay. Deliberately
  // understated: an invitation, not a temple ceremony.
  gameStartGong(out, rng) {
    const f0 = 164.8 // E3
    const ratios = [1, 1.505, 2.02, 2.94, 4.1]
    const taus = [0.42, 0.3, 0.21, 0.14, 0.09]
    const gains = [1, 0.55, 0.32, 0.18, 0.09]
    for (let i = 0; i < ratios.length; i++) {
      mode(out, {
        t: i * 0.002,
        freq: f0 * ratios[i] * jit(rng, 0.008),
        tau: taus[i],
        gain: gains[i],
        attack: 0.012 + i * 0.003, // soft mallet: highs bloom later
        drift: 0.015,
        phase: rng() * 6.28
      })
    }
    // beating partner just off the fundamental. Slow gong shimmer
    mode(out, { t: 0.004, freq: f0 * 1.006, tau: 0.42, gain: 0.45, attack: 0.02, phase: rng() * 6.28 })
    // felt mallet thump
    noiseBurst(out, rng, { t: 0, dur: 0.01, center: 380, q: 0.7, gain: 0.22, decay: 0.006 })
  }
}

// duration (s), normalization peak (≤0.85 keeps every file under −1 dBFS),
// and variant count per event.
const SPEC = {
  goStone: [0.3, 0.85, 3],
  discFlip: [0.15, 0.76, 3],
  discPlace: [0.18, 0.74, 3],
  discDrop: [0.46, 0.82, 3],
  pieceSlideCapture: [0.32, 0.8, 3],
  penStroke: [0.22, 0.5, 3],
  shogiPiece: [0.26, 0.85, 3],
  gameStartGong: [0.95, 0.58, 1]
}

// ---------------------------------------------------------------------------
// Render everything
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  let files = 0
  let bytes = 0
  for (const [event, build] of Object.entries(GAMES)) {
    const [dur, peak, variants] = SPEC[event]
    for (let v = 1; v <= variants; v++) {
      const rng = mulberry32(fnv1a(`games/${event}/${v}`))
      const out = makeBuf(dur)
      build(out, rng)
      finalize(out, peak)
      const name = variants > 1 ? `${event}.${v}.wav` : `${event}.wav`
      const wav = wavBytes(out)
      if (wav.length > 120 * 1024) {
        throw new Error(`${name} is ${(wav.length / 1024).toFixed(1)} KiB, over the 120 KiB per-file budget`)
      }
      await writeFile(path.join(OUT_DIR, name), wav)
      files++
      bytes += wav.length
    }
  }
  console.log(`games: ${files} files, ${(bytes / 1024).toFixed(1)} KiB -> ${path.relative(process.cwd(), OUT_DIR)}`)
}

main().catch((err) => {
  console.error('gen-game-sounds failed:', err)
  process.exitCode = 1
})
