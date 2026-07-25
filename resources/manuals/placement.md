# Placement

Placement (also known as Pre-chess or Benko chess) begins one step before
chess does: the pawns are on their usual squares, but the back ranks are
empty, and the players take turns **placing their own pieces** wherever
they like on their first rank. Setup is the opening. Once the sixteenth
piece lands, a normal game of chess breaks out. From a start position the
two of you designed, move by move, in plain sight of each other.

## The rules

The game has two phases.

**Phase one: placement.** Each player holds their eight back-rank pieces
in hand (king, queen, two rooks, two bishops, two knights). Starting with
White and alternating one piece at a time, each player places a piece from
hand on **any empty square of their own first rank**. Two constraints:

1. Your **bishops must end on opposite-colored squares**. The app simply
   won't offer a same-colored square for the second bishop.
2. That's it. Kings may go anywhere; nothing needs to mirror the opponent.

```position
8/pppppppp/8/8/8/8/PPPPPPPP/8[KQRRBBNNkqrrbbnn] w - - 0 1
```

No captures or checks are possible during this phase. The pawns keep the
armies apart, so the placement duel is pure information warfare: sixteen
alternating decisions, each one visible to the opponent before their next.

**Phase two: chess.** With all sixteen pieces placed, White moves first
and standard chess applies in full: normal piece movement, en passant,
promotion, check, checkmate, stalemate and all the usual draws.
**Castling exists only if you built it**: if your king and a rook stand on
their standard chess squares (king e1, rook a1 or h1; e8/a8/h8 for Black)
and neither has moved, castling with that rook is legal under the normal
conditions.

Placement moves are written like drops, `N@b1`, `K@e1`, and phase-two
moves as ordinary chess moves in the app's move list.

## Reading the board

During phase one your unplaced pieces sit in a **tray** beside the board,
exactly like a crazyhouse pocket; drag them onto your first rank (legal
squares highlight). The move list records the whole placement sequence, so
you can replay how the start position was negotiated. Phase two reads as a
standard chess board with SAN notation.

## Three principles

1. **Place reactively. Spend your commitments last.** The placement phase
   is a bidding war: knights and rooks are flexible almost anywhere, but
   the king and bishops define your game. Lead with the pieces whose best
   square doesn't depend on the opponent (knights toward the center files),
   and hold the king back until their attacking pieces have shown their
   diagonals and files.
2. **Aim pieces at their king's wing, not yours.** Every piece you place
   is a pre-aimed weapon. Once the enemy king commits to a side, stack
   value against it: bishops on diagonals that open toward it, a rook on
   the file the pawns in front of it will break. A start position with
   three pieces trained on the enemy king is worth a pawn or more.
3. **Don't forget the exit doors.** A brilliant aggressive setup that
   leaves your own king unplaceable. Every remaining square covered by
   inevitable open lines. Loses games before move one. Keep at least one
   safe region (usually behind an intact wing) for your king, and consider
   the standard-square placement just to keep castling alive.

## A classic pattern or trap

The recurring placement disaster is the **early king commitment**. Watch a
typical bidding sequence: 1. N@b1 N@g8 2. B@a1 B@c8 (so far so flexible)
and now Black, on autopilot, plays the "normal" 2... **K@e8?** early. White
still holds king, queen, rook and more, and every one of them can now be
placed with a known target. The queen goes where the e-file will open, a
bishop takes the diagonal pointing at e8's kingside pawn cover, and the
white king finally tucks into whichever corner Black's remaining pieces
can't reach.

The pattern to remember mirrors poker more than chess: **information is
material in phase one.** Each placement is a bet made in full view; the
player who reveals their king's address first has shown their whole hand
with half the deck still to be dealt. Delay your king, watch which
diagonals the enemy bishops claim, and place your last pieces as answers,
not guesses. When both players understand this, kings land in the final
two or three placements, and *that* silent standoff is the real opening
theory of Placement.
