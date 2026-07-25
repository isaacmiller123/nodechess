# Chess960 (Fischer Random)

Chess960 is standard chess with one twist: the back-rank pieces start in a
random arrangement: one of exactly **960** possible positions. Bobby Fischer
designed it to kill memorized opening theory and put both players on their own
from move one.

## The rules

Everything you know from standard chess still applies. Pieces move the same,
check, checkmate, stalemate, promotion and en passant are unchanged. Only the
setup differs:

1. White's back rank is shuffled, subject to two constraints: the **bishops
   must start on opposite colors**, and the **king must start somewhere
   between the two rooks**.
2. Black's pieces mirror White's exactly, so the position is symmetric.
3. Pawns start on their usual second rank.

Every legal shuffle satisfies both constraints, which is where the number 960
comes from.

## Castling, explained

Castling is the one rule that looks strange at first. It exists in Chess960
and follows the same spirit as standard chess, but the mechanics are
generalized:

- You still have two options per side: **kingside** ("g-side") and
  **queenside** ("c-side").
- No matter where the king and rook started, they always **land on the same
  squares as in standard chess**: king to g1 and rook to f1 (kingside), or
  king to c1 and rook to d1 (queenside). Black mirrors on the eighth rank.
- The usual conditions apply: neither the king nor the castling rook has
  moved; every square **between and including** the start and end squares of
  both pieces must be empty (except for the king and rook themselves); and the
  king may not castle out of, through, or into check.

> In this app you castle by dragging the king **onto its own rook**. That
> gesture is unambiguous even when the king only moves one square, or none
> at all.

Sometimes castling barely moves anything (the king may already stand on its
target square). It still counts as castling and still spends the right.

## Three principles for your first games

1. **Develop toward the center, not by habit.** Your standard-chess reflexes
   (knight to f3, bishop to c4) may be nonsense in the shuffled position.
   Look at where each piece actually wants to go: knights want central
   outposts, bishops want open diagonals. Read the position, not the muscle
   memory.
2. **Find the weak pawn before move five.** In many start positions one pawn
   (often b2/g2 or their mirror) is defended only by the king or not at all.
   Spot yours (and your opponent's) immediately: early games are decided by
   one-move threats against these squares.
3. **Castle early anyway.** The king starts between the rooks, often in the
   dead center of the rank. An uncastled king in Chess960 is in more danger
   than in standard chess because open lines appear faster. Work out which
   side is safer and commit.

## Two patterns to watch for

- **The undefended bishop battery.** When a bishop starts in a corner (a1 or
  h1) it often aims straight at the enemy's weak pawn through a long,
  soon-to-be-open diagonal. Opening that diagonal with a well-timed pawn push
  is the closest thing Chess960 has to an opening trap.
- **The queen fork on the loose rank.** With pieces on unusual squares,
  early queen sorties hit undefended piece pairs far more often than in
  standard chess. Before you push a pawn, ask what the enemy queen's best
  check or fork would be afterward.
