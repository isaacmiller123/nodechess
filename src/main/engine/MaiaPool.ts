import { UciEngine } from './UciEngine'
import {
  MAIA_LEVELS,
  type MaiaLevel,
  resolveLc0Path,
  maiaWeightPath,
  maiaWeightInstalled,
  lc0Installed
} from '../datasets/maia'

// Lazy pool of lc0 processes for the "Human" (Maia) bot style: one persistent
// engine per weight file, because lc0 loads its net at startup (a ~1s eigen
// backend spin-up we pay once per level, not once per move). Maia is played at
// nodes=1: the raw policy head IS the human-move model, so each move is a
// single NN eval: cheap enough that keeping a couple of levels resident is
// fine (~60MB RSS each, CPU idle between moves).
export class MaiaPool {
  private engines = new Map<MaiaLevel, UciEngine>()

  /** All maia levels playable right now (binary + that level's weights on disk). */
  availableLevels(): MaiaLevel[] {
    if (!lc0Installed()) return []
    return MAIA_LEVELS.filter((l) => maiaWeightInstalled(l))
  }

  async get(level: MaiaLevel): Promise<UciEngine> {
    const existing = this.engines.get(level)
    if (existing) return existing
    if (!maiaWeightInstalled(level)) {
      throw new Error(`maia: weights for level ${level} are not installed`)
    }
    const eng = new UciEngine(resolveLc0Path(), [`--weights=${maiaWeightPath(level)}`])
    await eng.start()
    // One thread is plenty for single-node evals; keep lc0 from grabbing cores
    // that the Stockfish analysis engine is using.
    eng.setOption('Threads', 1)
    await eng.isready()
    // If the process dies (crash, killAll from elsewhere), drop it from the map
    // so the next request respawns instead of writing to a dead stdin forever.
    eng.once('exit', () => {
      if (this.engines.get(level) === eng) this.engines.delete(level)
    })
    this.engines.set(level, eng)
    return eng
  }

  hasAny(): boolean {
    return this.engines.size > 0
  }

  killAll(): void {
    for (const eng of this.engines.values()) eng.kill()
    this.engines.clear()
  }
}
