import { parseFen } from 'chessops/fen'
import { Chess } from 'chessops/chess'
import { makeSan } from 'chessops/san'
function pos(fen){ const r=Chess.fromSetup(parseFen(fen).unwrap()); return r.isErr?null:r.unwrap() }
const VAL={pawn:1,knight:3,bishop:3,rook:5,queen:9,king:0}
const files='abcdefgh'; const sq=(f,r)=>files[f]+(r+1)
function build(pieces){let rows=[]; for(let r=7;r>=0;r--){let row='',e=0; for(let f=0;f<8;f++){const s=sq(f,r),pc=pieces[s]; if(pc){if(e){row+=e;e=0}row+=pc}else e++} if(e)row+=e; rows.push(row)} return rows.join('/')+' w - - 0 1'}
function evalMove(p, mv){ const before=p.board.get(mv.to); const immCap = before&&before.color==='black'?VAL[before.role]:0
  const p1=p.clone(); p1.play(mv); let minH=99
  for(const [bf,bs] of p1.allDests()) for(const bt of bs){ const p2=p1.clone(); p2.play({from:bf,to:bt})
    let best=0; for(const [wf,ws] of p2.allDests()) for(const wt of ws){const v=p2.board.get(wt); if(v&&v.color==='black') best=Math.max(best,VAL[v.role])}
    minH=Math.min(minH,best) }
  return {win: Math.max(immCap, minH), gaveCheck:p1.isCheck(), immCap} }
// King on b8 (dark): bishop must be DARK-squared to check it. Loose rook on a dark square too. bishop lands hitting both.
// Try dark-squared bishop, BK on b8, rook on a dark square, WK e1.
const out=[]
const bk='b8'
for(const rF of 'abcdefgh') for(const rR of [1,2,3,4,5,6,7,8]){ const rk=files[files.indexOf(rF)]+rR
  for(const bF of 'abcdefgh') for(const bR of [1,2,3,4,5,6,7]){ const b=files[files.indexOf(bF)]+bR
    const pieces={}; pieces[bk]='k'; pieces['e1']='K'; pieces[rk]='r'; pieces[b]='B'
    const used=Object.keys(pieces); if(new Set(used).size!==used.length) continue
    const fen=build(pieces); const p=pos(fen); if(!p||p.isCheck()||p.turn!=='white') continue
    let winMoves=[]; for(const [from,set] of p.allDests()) for(const to of set){ const e=evalMove(p,{from,to}); if(e.win>=5) winMoves.push({from,to,...e}) }
    if(winMoves.length===1 && winMoves[0].gaveCheck && p.board.get(winMoves[0].from).role==='bishop'){
      const land=sq(winMoves[0].to%8,Math.floor(winMoves[0].to/8)); const san=makeSan(p.clone(),{from:winMoves[0].from,to:winMoves[0].to})
      out.push({fen,rk,b,san,land}) }
  }
}
console.log('fresh unique bishop forks (BK b8):',out.length)
for(const r of out.slice(0,10)) console.log(`  ${r.san} land ${r.land}  R@${r.rk} B@${r.b}  ${r.fen}`)
