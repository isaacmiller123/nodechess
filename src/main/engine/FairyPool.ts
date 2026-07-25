import os from 'node:os'
import { UciEngine } from './UciEngine'
import { resolveFairyEnginePath } from '../datasets/fairyStockfish'

// One persistent Fairy-Stockfish instance for ALL variant bot play (games
// platform, docs/GAMES-PLATFORM-SPEC.md §Bots). Mirrors StockfishPool's play
// engine: small thread/hash budget, bounded `go`, callers serialize through
// engine.ipc's fairy chain so option changes can never interleave a search.
//
// The pool re-targets the single engine between variants with UCI_Variant +
// ucinewgame (verified across all 13 routed variants by
// scripts/probe-fairy-sf.mjs); chess960 additionally flips UCI_Chess960 so the
// engine speaks king-takes-rook castling both ways. Custom (Variant Lab)
// variants additionally point VariantPath at a variants.ini on disk BEFORE
// UCI_Variant: the ini load registers the variant name the option refers to.
export class FairyStockfishPool {
  private engine: UciEngine | null = null
  private variant: string | null = null
  private chess960 = false
  private variantPath: string | null = null

  private threads(): number {
    return Math.max(1, Math.min(2, os.cpus().length - 1))
  }

  /** The engine, spawned on first use and re-targeted to `variant`.
   *  `variantPath` (optional) is a variants.ini file for custom variants.
   *  It must be set before the UCI_Variant it defines. Loading an ini is
   *  additive in Fairy-Stockfish, so switching back to a built-in variant
   *  never requires unsetting it. */
  async get(variant: string, chess960: boolean, variantPath?: string): Promise<UciEngine> {
    if (!this.engine) {
      const e = new UciEngine(resolveFairyEnginePath())
      await e.start()
      e.setOption('Threads', this.threads())
      e.setOption('Hash', 64)
      await e.isready()
      this.engine = e
      this.variant = null // force the variant handshake below
      this.variantPath = null
    }
    const e = this.engine
    if (variantPath !== undefined && variantPath !== this.variantPath) {
      e.setOption('VariantPath', variantPath)
      await e.isready() // ini parse happens on the option. Settle before UCI_Variant
      this.variantPath = variantPath
      this.variant = null // re-select even if the name string matches
    }
    if (this.variant !== variant || this.chess960 !== chess960) {
      e.setOption('UCI_Variant', variant)
      e.setOption('UCI_Chess960', chess960)
      await e.newGame()
      this.variant = variant
      this.chess960 = chess960
    }
    return e
  }

  hasEngine(): boolean {
    return this.engine !== null
  }

  killAll(): void {
    this.engine?.kill()
    this.engine = null
    this.variant = null
    this.chess960 = false
    this.variantPath = null
  }
}
