import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, Repeat, RotateCcw, Trophy } from 'lucide-react'
import type { GameEntry } from '../../../games/registry'
import type { GameSpec } from '../../../games/kernel'
import {
  registerCustomVariant,
  type CustomVariantDef,
  type CustomVariantState
} from '../../../games/customVariants'
import { useSound } from '../../../sound/useSound'
import { useOtbOrientation } from '../useOtbOrientation'
import { useSaveFinishedGame } from '../useSaveFinishedGame'
import CustomBoard from './CustomBoard'

type Phase =
  | { t: 'loading' }
  | { t: 'error'; message: string }
  | { t: 'ready'; entry: GameEntry; game: CustomVariantState }

/**
 * Local over-the-board play for a Variant Lab creation: registers the variant
 * through the dynamic registry seam, then drives the GameSpec directly
 * (two humans, one machine: same model as VariantOtb). Accurate rules
 * end-to-end via ffish, auto-flip, sounds, result banner.
 */
export function PlayCustom({
  def,
  onBack
}: {
  def: CustomVariantDef
  onBack(): void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ t: 'loading' })
  const [autoFlip, setAutoFlip] = useState(true)
  const sound = useSound()
  // Register once per def identity; remember the entry across restarts.
  const defRef = useRef(def)

  useEffect(() => {
    let cancelled = false
    setPhase({ t: 'loading' })
    void (async () => {
      try {
        const entry = await registerCustomVariant(defRef.current, () => import('./CustomBoard'))
        if (cancelled) return
        const spec = entry.spec as GameSpec<CustomVariantState>
        setPhase({ t: 'ready', entry, game: spec.init() })
      } catch (err) {
        if (cancelled) return
        setPhase({ t: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onMove = useCallback(
    (move: string): void => {
      if (phase.t !== 'ready') return
      const spec = phase.entry.spec as GameSpec<CustomVariantState>
      const meta = spec.moveMeta(phase.game, move)
      const next = spec.play(phase.game, move)
      if (!next) return
      sound.play(meta.sound ?? 'move')
      setPhase({ ...phase, game: next })
    },
    [phase, sound]
  )

  const restart = useCallback((): void => {
    setPhase((p) => {
      if (p.t !== 'ready') return p
      const spec = p.entry.spec as GameSpec<CustomVariantState>
      return { ...p, game: spec.init() }
    })
  }, [])

  // Hooks stay above the early returns (hook-after-return caused a prior
  // crash. See CLAUDE.md). Chess-OTB flip timing: turn a beat after the move.
  const result =
    phase.t === 'ready' ? (phase.entry.spec as GameSpec<CustomVariantState>).result(phase.game) : null
  const turn: 'white' | 'black' =
    phase.t === 'ready' && phase.game.fen.split(' ')[1] === 'b' ? 'black' : 'white'
  const orientation = useOtbOrientation(turn, autoFlip && !result)

  // Archive every finished Lab game under its 'custom-<id>' kind (feature
  // foundation: reviewable later; replay re-registers the variant by id).
  useSaveFinishedGame(
    phase.t === 'ready' ? (phase.entry.spec as GameSpec<CustomVariantState>) : null,
    phase.t === 'ready' ? phase.game : null,
    result,
    {
      white: 'White',
      black: 'Black',
      event: `Variant Lab: ${def.name}`,
      source: 'custom',
      opponentKind: 'human',
      opponentLabel: 'Over the board'
    }
  )

  if (phase.t === 'loading') {
    return (
      <div className="vl-play-loading" role="status">
        <span className="view-spinner" aria-hidden />
        Loading {def.name}…
      </div>
    )
  }
  if (phase.t === 'error') {
    return (
      <div className="vl-error-panel" role="alert">
        <strong>{def.name} failed to load</strong>
        <p>{phase.message}</p>
        <button type="button" className="vl-btn" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> Back to the Lab
        </button>
      </div>
    )
  }

  const spec = phase.entry.spec as GameSpec<CustomVariantState>
  const game = phase.game
  const resultLabel =
    result &&
    (result.winner === null
      ? `Draw: ${result.reason}`
      : `${result.winner === 'white' ? 'White' : 'Black'} wins: ${result.reason}`)

  return (
    <div className="vl-play">
      <div className="vl-play-stage">
        <CustomBoard
          kind={spec.kind}
          state={game}
          orientation={orientation}
          interactive={!result}
          onMove={onMove}
        />
        {result && (
          <div className="vl-banner" role="status">
            <Trophy size={16} aria-hidden />
            <strong>{resultLabel}</strong>
            <button type="button" className="vl-btn is-primary" onClick={restart}>
              <RotateCcw size={14} aria-hidden /> Play again
            </button>
          </div>
        )}
      </div>
      <aside className="vl-play-side">
        <header className="vl-play-head">
          <h3>{def.name}</h3>
          {def.description && <p>{def.description}</p>}
        </header>
        <div className="vl-play-turn">
          <span className={`vl-turn-dot is-${turn}`} aria-hidden />
          {result ? 'Game over' : `${turn === 'white' ? 'White' : 'Black'} to move`}
          <span className="vl-play-movecount">{game.moves.length} moves</span>
        </div>
        <label className="vl-flip">
          <input
            type="checkbox"
            checked={autoFlip}
            onChange={(e) => setAutoFlip(e.target.checked)}
          />
          <Repeat size={14} aria-hidden />
          Auto-flip to the side to move
        </label>
        {game.moves.length > 0 && (
          <ol className="vl-movelist" aria-label="Moves played">
            {game.moves.map((m, i) => (
              <li key={`${i}-${m}`}>{m}</li>
            ))}
          </ol>
        )}
        <div className="vl-play-actions">
          <button type="button" className="vl-btn" onClick={restart}>
            <RotateCcw size={14} aria-hidden /> Restart
          </button>
          <button type="button" className="vl-btn" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden /> Back to the Lab
          </button>
        </div>
        <p className="vl-play-note">
          Over-the-board: pass the machine between moves. Bots and online play for custom variants
          land with the Fairy-Stockfish engine wave.
        </p>
      </aside>
    </div>
  )
}
