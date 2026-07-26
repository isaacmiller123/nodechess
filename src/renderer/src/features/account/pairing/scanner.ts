/**
 * The camera, and reading a code out of it.
 *
 * TWO DECODERS, ONE BUNDLED. Chrome, Edge and Android WebView ship
 * BarcodeDetector, which is native, fast and free of main-thread cost, so it is
 * used whenever it is really there (feature-detected AND asked whether it does
 * QR at all, because the object exists on some builds that only do barcodes).
 * Safari and Firefox do not have it, so jsQR (Apache-2.0) rides in the bundle
 * as the fallback. Nothing here loads from a network: the site is offline-first
 * and its headers require cross-origin isolation, so a CDN script would be
 * blocked even if we wanted one.
 *
 * THE CAMERA LIGHT IS A PROMISE. `stop()` ends the frame loop, stops every
 * track, and detaches the stream from the element. A camera still live after
 * the user closed the scanner is a trust problem, not a leak of resources, so
 * stop() is idempotent and is called from every exit path in the UI, including
 * unmount and page hide.
 *
 * EVERY FAILURE GETS A SENTENCE. There is no state in here that resolves to a
 * spinner. Permission denied, no camera, camera busy, insecure page and "this
 * browser cannot" each have their own message saying what happened and what to
 * do about it.
 */

import jsQR from 'jsqr'

export type CameraProblem =
  | 'insecure'
  | 'unsupported'
  | 'denied'
  | 'not-found'
  | 'busy'
  | 'unknown'

/** What went wrong with the camera, in the player's words. */
export function cameraProblemMessage(problem: CameraProblem): string {
  switch (problem) {
    case 'insecure':
      return 'The camera only works on a secure connection. Open nodechess over https and try again.'
    case 'unsupported':
      return 'This browser will not give a page access to the camera. You can paste the code instead, or use a different browser.'
    case 'denied':
      return 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again. You can also paste the code instead.'
    case 'not-found':
      return 'No camera found on this device. Paste the code instead.'
    case 'busy':
      return 'The camera is already in use by another app or tab. Close it and try again.'
    case 'unknown':
      return 'The camera could not be started. Try again, or paste the code instead.'
  }
}

/** Map a getUserMedia rejection onto one of the cases above. */
function problemOf(e: unknown): CameraProblem {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'not-found'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// BarcodeDetector, declared locally (it is not in the DOM lib)
// ---------------------------------------------------------------------------

interface DetectedCode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>
}

interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

function detectorCtor(): BarcodeDetectorCtor | null {
  const c = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof c === 'function' ? c : null
}

/** A native detector that really does QR, or null. Never throws. */
async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  const ctor = detectorCtor()
  if (!ctor) return null
  try {
    if (typeof ctor.getSupportedFormats === 'function') {
      const formats = await ctor.getSupportedFormats()
      if (!formats.includes('qr_code')) return null
    }
    return new ctor({ formats: ['qr_code'] })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

export interface ScannerHandle {
  /** Ends the loop, stops the tracks, detaches the stream. Idempotent. */
  stop(): void
}

export interface ScannerOpts {
  video: HTMLVideoElement
  /** Fired once, with the first code read. The caller stops the scanner. */
  onText: (text: string) => void
  onProblem: (problem: CameraProblem) => void
  /** Fired when frames start arriving, so the UI can drop its "starting" copy. */
  onLive?: () => void
}

/** How often we look at a frame. Eight times a second reads a held-up phone
 *  instantly and costs a fraction of what a per-frame decode costs a battery. */
const SCAN_INTERVAL_MS = 125

/** Longest edge we hand the fallback decoder. Full-resolution frames are slow
 *  to decode in JS and add nothing: a QR that does not resolve at 640 wide is
 *  one the human needs to move closer for anyway. */
const DECODE_MAX_EDGE = 640

/**
 * Open the camera and read until a code appears or `stop()` is called. Returns
 * as soon as the request is made; success and every failure arrive on the
 * callbacks, so a caller never waits on a promise that might not settle.
 */
export function startScanner(opts: ScannerOpts): ScannerHandle {
  const { video, onText, onProblem, onLive } = opts
  let stopped = false
  let stream: MediaStream | null = null
  let timer: number | null = null
  let canvas: HTMLCanvasElement | null = null

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    // The order matters only for tidiness; both halves must happen.
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    try {
      video.pause()
    } catch {
      /* a element that never played is fine to leave alone */
    }
    video.srcObject = null
    canvas = null
  }

  void (async () => {
    if (!globalThis.isSecureContext) {
      onProblem('insecure')
      return
    }
    const media = navigator.mediaDevices
    if (!media || typeof media.getUserMedia !== 'function') {
      onProblem('unsupported')
      return
    }

    let got: MediaStream
    try {
      got = await media.getUserMedia({
        // `ideal`, never `exact`: a laptop has one camera and no environment
        // facing mode, and asking for one it cannot honour fails the whole
        // request instead of handing over the webcam we actually want.
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
    } catch (e) {
      onProblem(problemOf(e))
      return
    }
    if (stopped) {
      for (const track of got.getTracks()) track.stop()
      return
    }
    stream = got
    video.srcObject = got
    video.setAttribute('playsinline', 'true')
    video.muted = true
    try {
      await video.play()
    } catch {
      // Autoplay refusal on a muted inline stream is rare; if it happens the
      // element still paints frames on some engines, so keep going rather than
      // failing a scanner that may well work.
    }
    if (stopped) {
      stop()
      return
    }
    onLive?.()

    const native = await nativeDetector()
    if (stopped) return
    let nativeBroken = false

    const readFrame = async (): Promise<string | null> => {
      if (video.readyState < 2 || video.videoWidth === 0) return null
      if (native && !nativeBroken) {
        try {
          const found = await native.detect(video)
          const first = found.find((c) => typeof c.rawValue === 'string' && c.rawValue.length > 0)
          return first ? first.rawValue : null
        } catch {
          // A detector that throws on this device's frames is a detector we
          // stop asking. The bundled decoder takes over for the rest of the
          // session rather than the scanner appearing to be broken.
          nativeBroken = true
        }
      }
      if (!canvas) canvas = document.createElement('canvas')
      const scale = Math.min(1, DECODE_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight))
      const w = Math.max(1, Math.round(video.videoWidth * scale))
      const h = Math.max(1, Math.round(video.videoHeight * scale))
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(video, 0, 0, w, h)
      const image = ctx.getImageData(0, 0, w, h)
      const result = jsQR(image.data, w, h, { inversionAttempts: 'attemptBoth' })
      return result ? result.data : null
    }

    let reading = false
    timer = window.setInterval(() => {
      if (stopped || reading) return
      reading = true
      void readFrame()
        .then((text) => {
          if (stopped || text === null) return
          onText(text)
        })
        .catch(() => {
          /* one bad frame is not a failure worth telling anyone about */
        })
        .finally(() => {
          reading = false
        })
    }, SCAN_INTERVAL_MS)
  })()

  return { stop }
}
