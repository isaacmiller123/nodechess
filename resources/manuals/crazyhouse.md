# Crazyhouse

Crazyhouse is chess where nothing ever really leaves the board: every piece
you capture defects to your side, and on any later turn you may **drop** it
back onto an empty square instead of moving. Material is fluid, attacks
never run out of fuel, and king safety matters more than anywhere else in
chess.

## The rules

Everything from standard chess applies. Setup, piece movement, castling,
en passant, promotion, check and checkmate, plus the drop rule:

1. When you capture a piece, it goes into your **pocket** (also called your
   reserve) as a piece of *your* color. Capture a black knight and you now
   own a white knight in hand.
2. On your turn you may either move a piece on the board **or drop** one
   piece from your pocket onto any **empty** square. A drop is a full move.
3. **Pawn drops are restricted**: pawns may not be dropped on the first or
   eighth rank. Every other piece may be dropped anywhere that is empty.
   Even to give check or **checkmate**.
4. A **promoted pawn is marked**, and if it is captured it goes into the
   opponent's pocket as a **pawn**, not as the piece it became.
5. A dropped pawn later promotes normally; a dropped rook does not restore
   castling rights.

Wins and draws are as in standard chess: checkmate wins; stalemate,
repetition, and agreement draw. (Insufficient material practically never
occurs: material returns.)

In our app drops are written engine-style as `P@e4`, `N@f3` and so on; the
move list shows the same `@` notation.

## Reading the board

Beside the board each player has a **pocket tray** showing the pieces in
hand with a count under each. To drop, drag a piece from your tray onto an
empty square (legal drop squares highlight). Everything else reads like the
standard chess board: SAN move list, last-move highlight, check glow. Keep
one eye on **both** trays at all times: a quiet position with two knights
in your opponent's pocket is not quiet.

```position
r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R[] w KQkq - 6 5
```

## Three principles

1. **Trades are never even.** When you exchange pieces you also hand your
   opponent ammunition. Only trade when the piece you gain in hand does more
   for you than theirs does for them. As a rule, the *attacker* profits
   from trades near the enemy king, the *defender* does not.
2. **Guard the squares next to your king, not just the king.** Mates arrive
   by drop on f2/f7, g2/g7 and h2/h7. A knight dropped on f7 supported by a
   bishop ends games instantly. Keep those squares covered by pieces, not
   just by the king, and think twice before pushing the pawns in front of a
   castled king.
3. **Material in hand is initiative.** A pawn in the pocket is worth more
   than a pawn on the board: it can appear exactly where it hurts. When
   attacking, count checks you can buy with drops; a forcing sequence that
   ends with a fresh piece in hand usually pays for itself.

## A classic pattern or trap

The classic demonstration is the **crazyhouse Fried Liver**, where the drop
rule turns a famous sacrifice into a rolling avalanche:

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5?! 6. Nxf7! Kxf7
7. Qf3+ Ke6, so far standard theory; the black king must defend the knight
on d5, and now the crazyhouse twist: 8. **P@f5+!** A pawn White captured
two moves ago materializes with check, gluing the king to the center.

```position
r1bq1b1r/ppp3pp/2n1k3/3npP2/2B5/5Q2/PPPP1PPP/RNB1K2R[Ppn] b KQ - 0 8
```

After 8... Kd6 9. Nc3 White develops with lethal threats against d5 and the
naked king, and every exchange feeds the white pocket. Note that Black is
not lost by force, but over the board the defense is close to hopeless.

The lesson generalizes: **any sacrifice that opens the king becomes twice as
strong when captured material can be re-dropped into the attack.** As the
defender, the same pattern in reverse saves games, a timely `P@g6` or
`B@f7` plug is often the only wall that holds. Before you grab a free-looking
piece near your king, ask what will be dropped into the hole it leaves.
