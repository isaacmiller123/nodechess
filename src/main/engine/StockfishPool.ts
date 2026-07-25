import os from 'node:os'
import { UciEngine } from './UciEngine'
import { stockfishPath } from './paths'

// Two persistent Stockfish instances (architecture §2.1 invariant):
//   - analysis: big budget, MultiPV 3-5, go infinite. The analysis board.
//   - play:     capped budget, MultiPV 1, bounded go, never starves analysis.
export class StockfishPool {
  private analysis: UciEngine | null = null
  private play: UciEngine | null = null

  private analysisThreads(): number {
    return Math.max(1, os.cpus().length - 1)
  }

  private playThreads(): number {
    // Intentionally small; the play engine may be Elo-limited anyway.
    return Math.max(1, Math.min(2, os.cpus().length - 1))
  }

  async getAnalysis(): Promise<UciEngine> {
    if (!this.analysis) {
      const e = new UciEngine(stockfishPath())
      await e.start()
      e.setOption('Threads', this.analysisThreads())
      e.setOption('Hash', 256)
      e.setOption('UCI_LimitStrength', false)
      await e.isready()
      this.analysis = e
    }
    return this.analysis
  }

  async getPlay(): Promise<UciEngine> {
    if (!this.play) {
      const e = new UciEngine(stockfishPath())
      await e.start()
      e.setOption('Threads', this.playThreads())
      e.setOption('Hash', 64)
      await e.isready()
      this.play = e
    }
    return this.play
  }

  hasAnalysis(): boolean {
    return this.analysis !== null
  }

  hasPlay(): boolean {
    return this.play !== null
  }

  killAll(): void {
    this.analysis?.kill()
    this.play?.kill()
    this.analysis = null
    this.play = null
  }
}
