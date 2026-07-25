# Makruk (Thai Chess)

Makruk is Thai chess. Often described as the closest living relative of
the medieval game that chess itself grew from. The queen is a short-range
sidestep, pawns start pre-advanced and promote early, and long endgames
run on a countdown clock written into the rules. It rewards patience,
structure, and precise endgame technique.

## The rules

The board is a plain **8×8**, files **a–h**, ranks **1–8**, and White
moves first. The setup differs from chess in two ways: all pawns start on
the **third rank** (and sixth for Black), and the king and queen-analog
are arranged so that **each king faces the enemy's met**, not the enemy
king: White's king stands on d1, Black's on e8.

```position
rnsmksnr/8/pppppppp/8/8/PPPPPPPP/8/RNSKMSNR w - - 0 1
```

The pieces:

- **King**: one square any direction, as in chess. No castling.
- **Met** (the "queen"): one square **diagonally** only. A humble but
  handy escort.
- **Khon** (the "bishop", a nobleman): one square diagonally, or one
  square **straight forward**: the shogi silver's move. It cannot slide.
- **Ma** (knight): exactly as the chess knight, jumps included.
- **Ruea** (the boat, our rook). Exactly as the chess rook: any distance
  orthogonally. The only long-range piece in the game.
- **Bia** (pawn): one square forward, capturing one square diagonally
  forward. **No double step, no en passant.** On reaching the **sixth
  rank** it promotes (always and immediately) to a **met**.

Check, checkmate and stalemate follow chess: checkmate wins, **stalemate
is a draw**. Draws also arise by repetition, agreement, and by makruk's
famous **counting rules**, which force the stronger side to prove a win:

- **Board count.** Once neither side has a pawn, the disadvantaged player
  may start counting; if 64 of their moves pass without mate, it's a draw.
- **Piece count.** When one side is down to a **bare king**, the count
  tightens: starting from the number of pieces still on the board, the
  attacker must mate before the count exceeds a limit fixed by his own
  material: **8 with two boats, 16 with one boat, 22 with two khon, 32
  with two knights, 44 with one khon, and 64 otherwise**. Fail, and the
  game is drawn.

Moves in our app are coordinates: `e3e4` pushes a pawn, `d5e6m` promotes
one to a met (the trailing `m` marks the promotion).

## Reading the board

The board reads like a chess board with the same coordinates. Mets and
khon are easily confused at first: the met sits beside the king and moves
only diagonally; the khon starts on c1/f1 (c8/f8) and adds the forward
step. Promoted mets are marked so you can tell them from the original.
When a counting rule is active, the app shows the running count beside the
clocks: treat it exactly as seriously as the material balance.

## Three principles

1. **Structure first. Nothing swings back.** With no long diagonals, no
   queen raids and no two-square pawn moves, makruk games are won by slow
   space-gaining. Advance pawns in connected fronts, develop knights
   centrally, and keep your khons' forward steps pointed at the squares
   you want to conquer. A single loose pawn is a bigger deal here than in
   chess: there is rarely a tactic to win it back.
2. **The sixth rank is the promised land.** A pawn on the sixth is a new
   met, and mets, khons and kings escort pawns beautifully. Two connected
   passed pawns crossing the middle usually outweigh a knight. Count every
   pawn race in mets, not queens: promotion is modest, but it is *early*
   and plentiful.
3. **Boats decide, so trade them on your terms.** The rook is the only
   piece that acts across the whole board; the side with the last boat
   dictates every endgame. Avoid lazy boat trades when you're better,
   and remember the counting table: a lone boat must mate a bare king
   within 16, so drive the enemy king toward a corner *before* the count
   starts.

## A classic pattern or trap

The technique every makruk player must own is the **boat mate against the
bare king**: king and rook versus king, under the count. The final
picture:

```position
3k4/8/3K4/8/8/8/8/R7 w - - 0 1
```

**1. Ra8#.** The boat seals the back rank; the white king, standing in
direct opposition two squares in front of its rival, guards every flight
square. The method to reach this picture is the classic ladder:
use the boat to fence the enemy king into an ever-smaller box, walk your
king up in opposition, and only give the final rank-check when the kings
stand directly opposed.

What makes this *makruk* rather than generic chess technique is the clock
ticking underneath it: **16 counted moves** is generous for a clean
ladder, and hopeless for an aimless one. Practice until the mate takes
you under a dozen moves from any position. Checking wildly, the classic
beginner sin, lets the count expire and turns a whole game's advantage
into a draw. The same discipline pays everywhere in makruk: the win
belongs to the player who converts *methodically*.
