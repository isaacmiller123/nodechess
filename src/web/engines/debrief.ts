// School debrief eval enrichment (audit fix W-01). On desktop, Viktor's
// debrief (src/main/coach/viktor.ts) fills in missing move evals with the
// NATIVE analysis engine server-side. The web server has no engine, so
// without this the bridge's debrief silently classified every move "fine"
// (cp:0 fallback), confidently-wrong coaching.
//
// The web fix runs the SAME enrichment CLIENT-side on the WASM analysis
// instance before webApi.school.debrief posts to the bridge: identical depth,
// identical position budget, identical mover-POV conventions, so a web debrief
// and a desktop debrief of the same game coach the same moves. Once every user
// move carries evals + a best line, the server-side Viktor never reaches for
// an engine.
//
// The analysis step is injectable (AnalyzeFn) so the headless suite can drive
// the enrichment over canned evals with zero WASM.

import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import type { CoachEngineEval, SchoolDebriefMove } from '@shared/types'
import { webEngineSupported } from './assets'
import { engineAnalyze, type AnalyzeFn } from './review'
import type { InfoLine } from './uci'

// Desktop constants (viktor.ts): keep in lockstep or web/desktop coaching drifts.
const DEBRIEF_DEPTH = 12
const MAX_POSITIONS = 24

export interface SchoolDebriefReq {
  chapterId: string
  userColor: 'white' | 'black'
  moves: SchoolDebriefMove[]
}

function hasEval(e: CoachEngineEval | undefined): boolean {
  return !!e && (e.cp != null || e.mate != null)
}

function infoToEval(info: InfoLine | undefined): CoachEngineEval {
  if (!info) return { cp: 0, mate: null }
  if (info.mate !== undefined) return { cp: null, mate: info.mate }
  return { cp: info.scoreCp ?? 0, mate: null }
}

function negate(e: CoachEngineEval): CoachEngineEval {
  return {
    cp: e.cp != null ? -e.cp : null,
    mate: e.mate != null ? -e.mate : null
  }
}

/** Enrich a debrief request's USER moves with WASM evals (viktor.ts's own
 *  loop, moved client-side). Per-move engine failures degrade exactly like
 *  desktop (that move keeps whatever evals it had), but if the engine answers
 *  NOTHING at all the whole call throws. An honest error beats a debrief
 *  that calls every blunder fine. */
export async function enrichDebriefMoves(
  req: SchoolDebriefReq,
  analyze: AnalyzeFn = engineAnalyze
): Promise<SchoolDebriefReq> {
  let budget = MAX_POSITIONS
  let attempted = 0
  let succeeded = 0
  const tracked: AnalyzeFn = async (fen, depth, multipv) => {
    attempted++
    const snap = await analyze(fen, depth, multipv)
    succeeded++
    return snap
  }

  const moves: SchoolDebriefMove[] = []
  for (const m of req.moves) {
    if (!m.byUser) {
      moves.push(m)
      continue
    }

    let best = m.best
    let pv = m.pv && m.pv.length ? m.pv : m.best ? [m.best] : []
    let evalBefore = m.evalBefore
    let evalAfter = m.evalAfter

    const needBefore = !hasEval(evalBefore) || !best
    const needAfter = !hasEval(evalAfter)
    const setup = parseFen(m.fenBefore)
    const fenBefore = setup.isErr ? null : makeFen(setup.value)

    if (fenBefore && (needBefore || needAfter) && budget > 0) {
      try {
        if (needBefore && budget > 0) {
          const snap = await tracked(fenBefore, DEBRIEF_DEPTH, 1)
          budget--
          const info = snap.lines.get(1)
          evalBefore = infoToEval(info) // side to move = the mover's POV
          if (info?.pv && info.pv.length) {
            pv = info.pv
            best = info.pv[0]
          }
        }
        // Eval AFTER the played move: mate is terminal, the best move reuses
        // the before-eval, anything else pays for a second (negated) search.
        if (needAfter && budget > 0) {
          const pos = Chess.fromSetup(parseFen(fenBefore).unwrap()).unwrap()
          const playedMove = parseUci(m.played)
          if (playedMove && pos.isLegal(playedMove)) {
            const after = pos.clone()
            after.play(playedMove)
            if (after.isCheckmate()) {
              evalAfter = { cp: null, mate: 1 } // user delivered mate
            } else if (m.played === best) {
              evalAfter = evalBefore
            } else {
              const snap = await tracked(makeFen(after.toSetup()), DEBRIEF_DEPTH, 1)
              budget--
              evalAfter = negate(infoToEval(snap.lines.get(1))) // opp POV -> mover POV
            }
          }
        }
      } catch {
        // Engine hiccup mid-debrief: keep whatever evals this move has.
        // The same degradation as desktop's in-viktor catch.
      }
    }

    moves.push({ ...m, best, pv, evalBefore, evalAfter })
  }

  if (attempted > 0 && succeeded === 0) {
    throw new Error(
      'Viktor’s debrief needs the analysis engine, and it isn’t answering in this browser.'
    )
  }
  return { ...req, moves }
}

/** Factory in the engine-layer style (webApi's lazy() caches it; throwing at
 *  construction parks the cache at null → webApi rejects with honest copy). */
export function buildDebriefEnrich(): (req: SchoolDebriefReq) => Promise<SchoolDebriefReq> {
  if (!webEngineSupported()) {
    throw new Error('web debrief enrichment unavailable: no Worker/WebAssembly in this environment')
  }
  return (req) => enrichDebriefMoves(req)
}
