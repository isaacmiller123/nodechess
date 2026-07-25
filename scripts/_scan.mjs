import { parseFen } from 'chessops/fen'
import { Chess } from 'chessops/chess'
import { makeUci } from 'chessops/util'
function pos(fen){ const s=parseFen(fen); if(s.isErr) return null; const p=Chess.fromSetup(s.unwrap()); return p.isErr?null:p.unwrap() }
function legalMoves(p){ const out=[]; for(const [from,dests] of p.allDests()) for(const to of dests){ const pc=p.board.get(from); const tr=to>>3; if(pc&&pc.role==='pawn'&&(tr===7||tr===0)){for(const r of ['queen','rook','bishop','knight'])out.push({from,to,promotion:r})} else out.push({from,to}) } return out }
function after(p,m){const c=p.clone();c.play(m);return c}
function m2firstCheck(p){ // return list of {u, kind, replies} only for unique-forcing; flag if any mate1
  const res=[]
  for(const mv of legalMoves(p)){
    const np=after(p,mv); const u=makeUci(mv)
    if(np.isCheckmate()){res.push({u,kind:'M1'});continue}
    if(np.isStalemate())continue
    const replies=legalMoves(np); if(replies.length===0) continue
    let all=true
    for(const r of replies){ const rp=after(np,r); let f=false; for(const wm of legalMoves(rp)){ if(after(rp,wm).isCheckmate()){f=true;break} } if(!f){all=false;break} }
    if(all) res.push({u,kind:np.isCheck()?'M2C':'M2Q',replies:replies.length})
  }
  return res
}
const FILES='abcdefgh'
// fix Black Kh8, White Kf6 (not adjacent? f6-h8 fine). Place ONE white rook on every empty square. Look for: no M1, exactly one M2 and it's a CHECK.
const wk='f6', bk='h8'
function sq(f,r){return f+r}
let hits=[]
for(let f=0;f<8;f++)for(let r=1;r<=8;r++){
  const rsq=sq(FILES[f],r)
  if(rsq===wk||rsq===bk) continue
  const fen=placeFen(bk,wk,rsq)
  const p=pos(fen); if(!p) continue
  const res=m2firstCheck(p)
  const m1=res.filter(x=>x.kind==='M1')
  const m2=res.filter(x=>x.kind!=='M1')
  const checks=m2.filter(x=>x.kind==='M2C')
  if(m1.length===0 && m2.length===1 && checks.length===1){ hits.push(fen+'  => '+checks[0].u+' (M2-CHECK, replies='+checks[0].replies+')') }
}
function placeFen(bkSq,wkSq,rSq){
  // build 8x8
  const board=Array.from({length:8},()=>Array(8).fill(null))
  const put=(s,c)=>{const f=FILES.indexOf(s[0]); const r=parseInt(s[1])-1; board[r][f]=c}
  put(bkSq,'k'); put(wkSq,'K'); put(rSq,'R')
  let rows=[]
  for(let r=7;r>=0;r--){ let row=''; let e=0; for(let f=0;f<8;f++){ const c=board[r][f]; if(c){ if(e){row+=e;e=0} row+=c } else e++ } if(e)row+=e; rows.push(row) }
  return rows.join('/')+' w - - 0 1'
}
console.log('Kf6 vs Kh8, single rook scan. Clean rook-CHECK mate-in-2:')
hits.forEach(h=>console.log('  ',h))
console.log('total hits:',hits.length)
