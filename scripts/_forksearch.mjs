import { parseFen } from 'chessops/fen'
import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import { makeSan } from 'chessops/san'
import { SquareSet } from 'chessops/squareSet'
function pos(fen){ const r=Chess.fromSetup(parseFen(fen).unwrap()); return r.isErr?null:r.unwrap() }
const VAL={pawn:1,knight:3,bishop:3,rook:5,queen:9,king:0}
const files='abcdefgh'
function sq(f,r){return files[f]+(r+1)}
// knight on e7 attacks these target squares:
const targets=['c8','g8','c6','g6','d5','f5'] // pick 2 for queen+rook
// launch squares for e7 (knight can move to e7 from): c6,c8,d5,f5,g6,g8 -> avoid ones used by targets
function tryBoard(qSq,rSq,launch,bk,wk,wpawns,bpawns){
  // build piece map
  const pieces={}
  pieces[bk]='k'; pieces[wk]='K'; pieces[launch]='N'; pieces[qSq]='q'; pieces[rSq]='r'
  for(const p of wpawns) pieces[p]='P'
  for(const p of bpawns) pieces[p]='p'
  // ensure no square reused
  const used=Object.keys(pieces); if(new Set(used).size!==used.length) return null
  // build FEN ranks 8..1
  let rows=[]
  for(let r=7;r>=0;r--){ let row=''; let empty=0
    for(let f=0;f<8;f++){ const s=sq(f,r); const pc=pieces[s]
      if(pc){ if(empty){row+=empty;empty=0} row+=pc } else empty++ }
    if(empty)row+=empty; rows.push(row) }
  const fen=rows.join('/')+' w - - 0 1'
  const p=pos(fen); if(!p) return null
  if(p.isCheck()) return null // white not already in check
  const fm=parseUci(launch+'e7'); if(!p.isLegal(fm)) return null
  const sanFork=makeSan(p,fm)
  const after=p.clone(); after.play(fm)
  if(after.isCheck()) return null // MUST be quiet (no check)
  // verify: no black reply gives check, and every reply leaves a target (>=rook) capturable
  let minHarvest=99
  for(const [from,set] of after.allDests()) for(const to of set){
    const p2=after.clone(); p2.play({from,to})
    if(p2.isCheck()) return null // black must have NO check available
    let best=0; for(const [wf,ws] of p2.allDests()) for(const wt of ws){const v=p2.board.get(wt); if(v&&v.color==='black') best=Math.max(best,VAL[v.role])}
    minHarvest=Math.min(minHarvest,best)
  }
  if(minHarvest<5) return null // must always win at least a rook
  return {fen,sanFork,minHarvest}
}
// search space: queen+rook on two of the targets; launch from remaining launch squares; kings + minimal pawns
const launchSquares=['c6','c8','d5','f5','g6','g8']
const results=[]
for(let i=0;i<targets.length;i++) for(let j=0;j<targets.length;j++){ if(i===j) continue
  const qSq=targets[i], rSq=targets[j]
  for(const launch of launchSquares){ if(launch===qSq||launch===rSq) continue
    // try several black king squares (off radius) and white king corners with luft pawns
    const bkOpts=['a8','h8','a7','h7','b8','g7','a6','h6']
    const wkSetups=[
      {wk:'g1',wp:['f2','g2','h3']}, // luft via h3
      {wk:'g1',wp:['f2','g3','h2']},
      {wk:'h2',wp:['g2','h3','f2']},
      {wk:'h1',wp:['g2','h2','f2']},
      {wk:'a1',wp:['a2','b2','b3']},
      {wk:'b1',wp:['a2','b2','c2']},
      {wk:'g2',wp:['f2','g3','h2']},
      {wk:'h2',wp:['f2','g3','h2']},
    ]
    for(const bk of bkOpts){ if(bk===qSq||bk===rSq||bk===launch) continue
      for(const ws of wkSetups){
        const bpawns=[] // start with no black pawns (sparser, fewer surprises), but black needs SOME pawns? not required
        const res=tryBoard(qSq,rSq,launch,bk,ws.wk,ws.wp,bpawns)
        if(res) results.push({...res,qSq,rSq,launch,bk,wk:ws.wk})
      }
    }
  }
}
console.log('found', results.length, 'valid quiet-fork boards. Samples:')
for(const r of results.slice(0,12)) console.log(`  ${r.sanFork} q@${r.qSq} r@${r.rSq} N@${r.launch} bk@${r.bk} wk@${r.wk} harvest+${r.minHarvest}  FEN: ${r.fen}`)
