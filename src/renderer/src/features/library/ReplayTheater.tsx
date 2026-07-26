// Replay Theater: cinematic full-screen replay of a finished game.
//
// 3D-capable kinds (spec WILL tier: chess-family standard boards, checkers,
// go, gomoku, othello, connect four) play on the shared Tabletop3D via the
// GameBoard3D bridge in theater mode: slow orbiting camera, per-move framing,
// capture emphasis (dolly-in + brief scene slow-mo through the existing slide
// and lift-fade animations), final-position hold with a result card. Every
// other kind (and any machine without WebGL) falls back to a polished 2D
// autoplay of the same data on the kind's real board.
//
// Choreography lives in games/three/theater.ts (pure, node-tested); this
// component owns PLAYBACK. The ply cursor, cadence timing, transport
// controls (play/pause, scrub over the move strip, 0.5×–3× speed), and the
// .webm export (MediaRecorder over the 3D canvas; see startExport below).
// Launchers: the Library replay viewer and the local post-game banners.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type JSX
} from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play, RotateCcw, Video, X } from 'lucide-react'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import type { GameKind, GameSpec } from '../../games/kernel'
import type { GameBoardProps, GameEntry } from '../../games/registry'
import { useBoardSound } from '../../games/boards/useBoardSound'
import { useSound } from '../../sound/useSound'
import {
  EXPORT_TAIL_MS,
  FINALE_CARD_DELAY_MS,
  THEATER_SPEEDS,
  defaultDirective,
  establishMs,
  plyDurationMs
} from '../../games/three/theater'
import { kernelColorLabel } from '../games/KernelOtb'
import { tabletop3dOffered } from '../games/boardMode'
import { buildReplay, type ReplayLine } from './replayData'
// The theater borrows .b3d-* (3D host sizing), .votb-* (buttons/dots) and
// .replay-speed* rules: import their sheets here so every launch surface
// (and the ?theater harness) is self-sufficient; Vite dedupes repeats.
import '../games/games.css'
import './library.css'
import './theater.css'

/** Everything the theater needs about one finished game. */
export interface TheaterInput {
  kind: string
  entry: GameEntry
  replay: ReplayLine
  /** '1-0' | '0-1' | '1/2-1/2' | '*' (unknown). */
  result: string
  reason?: string
  white?: string
  black?: string
  event?: string
}

/** Build a TheaterInput from a LIVE finished game (post-game banners): replay
 *  the move history through the spec. Never throws. An unreplayable tail is
 *  truncated (buildReplay contract). */
export function buildTheaterInput(args: {
  entry: GameEntry
  moves: readonly string[]
  options?: unknown
  result: string
  reason?: string
  white?: string
  black?: string
  event?: string
}): TheaterInput {
  const spec = args.entry.spec as GameSpec<unknown>
  const replay = buildReplay(spec, {
    kind: spec.kind,
    moves: [...args.moves],
    options: args.options,
    format: 'envelope'
  })
  return {
    kind: spec.kind,
    entry: args.entry,
    replay,
    result: args.result,
    reason: args.reason,
    white: args.white,
    black: args.black,
    event: args.event
  }
}

// The three.js chunk: same lazy chunk boardMode.tsx mounts for live play.
const GameBoard3DTheater = lazy(() => import('../../games/three/GameBoard3D'))

// Lazy 2D boards cached per kind (KernelOtb discipline).
const BOARD_CACHE = new Map<string, ComponentType<GameBoardProps>>()
function lazyBoard(kind: string, entry: GameEntry): ComponentType<GameBoardProps> {
  const cached = BOARD_CACHE.get(kind)
  if (cached) return cached
  const Board = lazy(entry.loadRenderer) as unknown as ComponentType<GameBoardProps>
  BOARD_CACHE.set(kind, Board)
  return Board
}

/** Best MediaRecorder container Electron 42 offers (VP9 → VP8 → any webm). */
export function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return null
}

function resultLine(input: TheaterInput): string {
  const reason = input.reason ? input.reason.replace(/-/g, ' ') : null
  if (input.result === '1-0' || input.result === '0-1') {
    const side = kernelColorLabel(input.kind, input.result === '1-0' ? 'white' : 'black')
    return reason ? `${side} wins: ${reason}` : `${side} wins`
  }
  if (input.result === '1/2-1/2') return reason ? `Draw: ${reason}` : 'Draw'
  return 'Game over'
}

const noop = (): void => {}

type ExportPhase = 'idle' | 'recording' | 'saving'

export function ReplayTheater({
  data,
  onExit
}: {
  data: TheaterInput
  onExit: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const { play, manager } = useSound()
  const { kind, entry, replay } = data
  const spec = entry.spec as GameSpec<unknown>
  const isChessFamily = spec.family === 'chess'
  const total = replay.moves.length

  const [ply, setPly] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speedIdx, setSpeedIdx] = useState(1) // 1×
  const [fallback2d, setFallback2d] = useState(false)
  const [showCard, setShowCard] = useState(false)
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle')

  const speed = THEATER_SPEEDS[speedIdx].x
  const use3d = tabletop3dOffered(kind) && !fallback2d
  const state = replay.states[ply]
  const finale = total > 0 && ply >= total
  const exporting = exportPhase !== 'idle'

  // Capture flags per move (spec.moveMeta of the move about to be played).
  const captures = useMemo(
    () =>
      replay.moves.map((m, i) => {
        try {
          return spec.moveMeta(replay.states[i], m).capture === true
        } catch {
          return false
        }
      }),
    [spec, replay]
  )

  // ---- Choreography directive (a ref: the 3D rig samples it per frame) -----
  const directiveRef = useRef(defaultDirective())
  useEffect(() => {
    directiveRef.current.speed = speed
  }, [speed])
  useEffect(() => {
    directiveRef.current.finale = finale
    directiveRef.current.paused = !playing && !finale
  }, [playing, finale])
  const shot = useMemo(
    () => (ply > 0 ? { ply, capture: captures[ply - 1] === true } : null),
    [ply, captures]
  )

  // ---- Playback cadence ------------------------------------------------------
  useEffect(() => {
    if (!playing) return
    if (ply >= total) {
      setPlaying(false)
      return
    }
    const justCapture = ply > 0 && captures[ply - 1]
    const delay = ply === 0 ? establishMs(speed) : plyDurationMs(justCapture, speed)
    const timer = window.setTimeout(() => setPly((p) => Math.min(total, p + 1)), delay)
    return () => window.clearTimeout(timer)
  }, [playing, ply, total, captures, speed])

  // Board sounds: 3D bridge + non-chess 2D boards self-sound; the chess family
  // is the view's job (mirrors GameBoard3D's contract, no double-play).
  useBoardSound(kind as GameKind, isChessFamily ? state : null)

  // Curtain-up + final-whistle sounds (each latched once).
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    play(kind === 'go' ? 'gameStartGong' : 'gameStart')
  }, [play, kind])
  const endedRef = useRef(false)
  useEffect(() => {
    if (!finale) {
      endedRef.current = false
      setShowCard(false)
      return
    }
    if (!endedRef.current) {
      endedRef.current = true
      play('gameEnd')
    }
    const timer = window.setTimeout(() => setShowCard(true), FINALE_CARD_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [finale, play])

  // ---- Transport -------------------------------------------------------------
  const scrubTo = useCallback((p: number) => {
    setPlaying(false)
    setPly(p)
  }, [])
  const togglePlay = useCallback(() => {
    if (finale) {
      // Roll the credits back: replay from the establishing shot.
      setPly(0)
      setPlaying(true)
      return
    }
    setPlaying((v) => !v)
  }, [finale])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        onExit()
      } else if (exporting) {
        return // transport is locked while recording
      } else if (e.key === ' ') {
        togglePlay()
      } else if (e.key === 'ArrowLeft') {
        scrubTo(Math.max(0, ply - 1))
      } else if (e.key === 'ArrowRight') {
        scrubTo(Math.min(total, ply + 1))
      } else {
        return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onExit, togglePlay, scrubTo, ply, total, exporting])

  // Move strip follows the playhead.
  const currentChipRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    currentChipRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [ply])

  // ---- Export (.webm via MediaRecorder over the 3D canvas) --------------------
  // The recording is the canvas alone (the result card is DOM chrome and stays
  // out of frame: the take ends on the final-position hold). Board sounds ARE
  // included via the SoundManager's master-gain recording tap.
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const recRef = useRef<{ rec: MediaRecorder; chunks: Blob[] } | null>(null)
  const onCanvasReady = useCallback((canvas: HTMLCanvasElement) => {
    canvasRef.current = canvas
  }, [])
  const canExport = use3d && pickRecorderMime() !== null && window.api?.dialog !== undefined

  const discardRecorder = useCallback(() => {
    const r = recRef.current
    recRef.current = null
    if (!r) return
    try {
      r.rec.stream.getVideoTracks().forEach((t) => t.stop())
      if (r.rec.state !== 'inactive') r.rec.stop()
    } catch {
      /* already stopped */
    }
  }, [])

  const startExport = useCallback(() => {
    const canvas = canvasRef.current
    const mime = pickRecorderMime()
    if (!canvas || !mime || exportPhase !== 'idle') return
    const stream = canvas.captureStream(60)
    // Mix the board sounds in (video-only when audio is unavailable). Never
    // stop these tracks. The tap is shared and lives with the SoundManager.
    const audio = manager.recordingStream()
    if (audio) for (const t of audio.getAudioTracks()) stream.addTrack(t)
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
    } catch {
      return
    }
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recRef.current = { rec, chunks }
    rec.start(250)
    setExportPhase('recording')
    // Deterministic take: restart from the establishing shot.
    setPly(0)
    setPlaying(true)
  }, [exportPhase, manager])

  const finishExport = useCallback(async (): Promise<void> => {
    const r = recRef.current
    if (!r) return
    setExportPhase('saving')
    const blob = await new Promise<Blob>((resolve) => {
      r.rec.onstop = () => resolve(new Blob(r.chunks, { type: 'video/webm' }))
      try {
        r.rec.stop()
      } catch {
        resolve(new Blob(r.chunks, { type: 'video/webm' }))
      }
    })
    r.rec.stream.getVideoTracks().forEach((t) => t.stop())
    recRef.current = null
    try {
      if (blob.size > 0) {
        const data = new Uint8Array(await blob.arrayBuffer())
        await window.api?.dialog.saveFile({
          suggestedName: `${kind}-replay.webm`,
          filterName: 'WebM video',
          extensions: ['webm'],
          data
        })
      }
    } catch {
      /* save dialog failed/declined: the user can export again */
    }
    setExportPhase('idle')
  }, [kind])

  // The take ends after the final hold has breathed for a moment.
  useEffect(() => {
    if (exportPhase !== 'recording' || !finale) return
    const timer = window.setTimeout(() => void finishExport(), FINALE_CARD_DELAY_MS + EXPORT_TAIL_MS)
    return () => window.clearTimeout(timer)
  }, [exportPhase, finale, finishExport])

  const cancelExport = useCallback(() => {
    discardRecorder()
    setExportPhase('idle')
  }, [discardRecorder])
  useEffect(() => discardRecorder, [discardRecorder]) // unmount: drop any live take

  // ---- Render ------------------------------------------------------------------
  const title = spec.title
  const whiteName = data.white ?? kernelColorLabel(kind, 'white')
  const blackName = data.black ?? kernelColorLabel(kind, 'black')
  const caption = ply > 0 ? replay.notated[ply - 1] : title
  const progress = total > 0 ? Math.min(100, Math.round((ply / total) * 100)) : 0
  const Board2D = use3d ? null : lazyBoard(kind, entry)
  const board2dCls = isChessFamily
    ? `votb-cfb board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`
    : 'theater-2d-host'

  const overlay = (
    <div className="theater" role="dialog" aria-modal="true" aria-label={`${title} replay theater`}>
      <header className="theater-top">
        <div className="theater-billing">
          <span className="theater-player">
            <span className="votb-turn-dot is-white" aria-hidden /> {whiteName}
          </span>
          <span className={`theater-score num${data.result === '*' ? ' is-open' : ''}`}>
            {data.result === '*' ? 'vs' : data.result}
          </span>
          <span className="theater-player">
            <span className="votb-turn-dot is-black" aria-hidden /> {blackName}
          </span>
          {data.event && <span className="theater-event">{data.event}</span>}
        </div>
        {exporting && (
          <div className="theater-rec" role="status">
            <span className="theater-rec-dot" aria-hidden />
            {exportPhase === 'saving' ? 'Finishing…' : `Recording ${progress}%`}
            {exportPhase === 'recording' && (
              <button type="button" className="theater-rec-cancel" onClick={cancelExport}>
                Cancel
              </button>
            )}
          </div>
        )}
        <button type="button" className="theater-close" onClick={onExit} title="Close (esc)">
          <X size={18} aria-hidden />
        </button>
      </header>

      <div className={`theater-stage${use3d ? '' : ' theater-2d'}`}>
        <Suspense fallback={<div className="b3d-shimmer" role="status" aria-label="Raising the curtain" />}>
          {use3d ? (
            <GameBoard3DTheater
              kind={kind as GameKind}
              state={state}
              orientation="white"
              interactive={false}
              onMove={noop}
              theater={directiveRef}
              theaterShot={shot}
              onCanvasReady={onCanvasReady}
              onUnavailable={() => setFallback2d(true)}
            />
          ) : (
            Board2D && (
              <div className={`theater-2d-frame ${board2dCls}`}>
                <Board2D
                  kind={kind as GameKind}
                  state={state}
                  orientation="white"
                  interactive={false}
                  onMove={noop}
                />
              </div>
            )
          )}
        </Suspense>

        {showCard && (
          <div className="theater-card" role="status">
            <span className={`theater-card-score num score-${data.result.replace(/\//g, '')}`}>
              {data.result === '*' ? '·' : data.result}
            </span>
            <strong className="theater-card-line">{resultLine(data)}</strong>
            <span className="theater-card-players">
              {whiteName} · {blackName}
              {total > 0 && <span className="num"> · {total} moves</span>}
            </span>
            {!exporting && (
              <div className="theater-card-actions">
                <button type="button" className="votb-btn is-primary" onClick={togglePlay}>
                  <RotateCcw size={14} aria-hidden /> Watch again
                </button>
                <button type="button" className="votb-btn" onClick={onExit}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="theater-bottom">
        <p className="theater-caption" aria-live="polite">
          {caption}
          <span className="theater-caption-count num">
            {ply}/{total}
          </span>
        </p>
        <div className="theater-transport">
          <button
            type="button"
            className="icon-btn"
            onClick={togglePlay}
            disabled={exporting || total === 0}
            title={finale ? 'Watch again' : playing ? 'Pause (space)' : 'Play (space)'}
          >
            {finale ? <RotateCcw size={18} /> : playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <input
            type="range"
            className="theater-scrub"
            min={0}
            max={total}
            step={1}
            value={ply}
            disabled={exporting || total === 0}
            onChange={(e) => scrubTo(Number(e.target.value))}
            aria-label="Scrub through the game"
            style={{ '--fill': `${progress}%` } as CSSProperties}
          />
          <div className="replay-speeds" role="radiogroup" aria-label="Playback speed">
            {THEATER_SPEEDS.map((s, i) => (
              <button
                key={s.label}
                type="button"
                role="radio"
                aria-checked={speedIdx === i}
                className={`replay-speed num${speedIdx === i ? ' is-active' : ''}`}
                disabled={exporting}
                onClick={() => setSpeedIdx(i)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {canExport && (
            <button
              type="button"
              className="icon-btn"
              onClick={startExport}
              disabled={exporting || total === 0}
              title="Export replay (.webm)"
            >
              <Video size={18} aria-hidden />
            </button>
          )}
        </div>
        {total > 0 && (
          <div className="theater-strip" role="list" aria-label="Moves">
            {replay.notated.map((n, i) => (
              <button
                key={i}
                type="button"
                ref={ply === i + 1 ? currentChipRef : undefined}
                className={`theater-chip num${ply === i + 1 ? ' is-current' : ''}`}
                disabled={exporting}
                onClick={() => scrubTo(i + 1)}
              >
                {n}
              </button>
            ))}
          </div>
        )}
      </footer>
    </div>
  )

  return createPortal(overlay, document.body)
}
