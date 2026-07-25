# Racing Kings

Racing Kings strips chess down to a footrace: both armies start shoulder to
shoulder on the first two ranks, checks are illegal, and the first king to
reach the eighth rank wins. No mating attacks, no king hunts: pure
geometry, tempo counting, and fences.

## The rules

Piece movement is standard, but the game itself is rebuilt:

1. **Setup.** All pieces begin on ranks 1 and 2, kings already "castled
   out": White's army occupies the e–h files (king on h2, queen on h1),
   Black's mirrors it on the a–d files (king on a2, queen on a1). There are
   **no pawns**.

```position
8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1
```

2. **First king to the eighth rank wins.** The finish line is any square
   on rank 8, for both players.
3. **Checks are illegal. For both sides.** Any move that would attack the
   enemy king is simply not allowed. Consequently there is no checkmate,
   and kings can never stand on adjacent squares.
4. **The equalizing move.** White moves first, so if White's king reaches
   the eighth rank and Black's king can reach it on the very next move,
   Black is allowed that move and the game is a **draw**. If Black reaches
   the goal first, the game ends at once: White already had his turn.
5. Captures are legal (as long as they don't give check). Stalemate, no
   legal move, is a draw. Repetition and agreement draw as usual.

Moves appear in standard SAN; you will simply never see `+` or `#`.

## Reading the board

The eighth rank (the finish line for both kings) is highlighted. The
board otherwise reads as standard chess. Because checks are illegal, squares
that *would* expose the enemy king silently vanish from your legal moves;
if a piece refuses to go somewhere, that's usually why. Count tempi
constantly: the position is always "White's king is N moves from the line,
Black's is M."

## Three principles

1. **Fences beat sprints.** A rook or queen placed on a rank or file ahead
   of the enemy king is a wall the king cannot cross. Kings may not step
   onto attacked squares. One good fence is worth three king moves. Look
   for fences that also shelter your own king's path.
2. **Your pieces are obstacles too.** The h-file army is cramped; a king
   that bolts too early gets stuck behind its own knights and bishops.
   Clear the runway with purpose: each piece should either fence, screen
   your king from lateral attacks, or get out of the way.
3. **Use the no-check rule as armor.** Since no move may check, your king
   can safely walk beside enemy lines of force, and pieces that "defend by
   checking" don't exist. A piece is only ever stopped by a square being
   attacked, so control squares, not pieces, and remember that capturing
   defenders is often illegal when the recapture would expose a king.

## A classic pattern or trap

The signature motif is the **poisoned fence**. Consider this endgame race:

```position
8/R7/5K2/1k6/q7/8/8/8 w - - 0 1
```

White's rook on a7 fences the entire seventh rank: the black king on b5 may
never step onto an attacked square, so it cannot cross. White plays
**1. Kf7**, strolling toward the goal, and here is the trick: Black's
queen **cannot take the rook**. 1... Qxa7 would attack the white king along
the seventh rank, and *giving check is illegal*. The capture simply is not
a legal move. The rook is immune, held in place by the very rule that keeps
kings safe. After **1... Kb6 2. Kf8** White crosses the line; Black's king
is nowhere near rank 8, so there is no equalizing move and White wins.

The pattern cuts both ways. Whenever your opponent relies on a guard, ask
whether capturing it would give check. If so, the guard is absolute.
Conversely, never build your own race around a defender that a quiet enemy
move could unpin. In Racing Kings, the truly untouchable piece is the one
standing between your king and the capture square.
