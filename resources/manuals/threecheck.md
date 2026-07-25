# Three-check

Three-check is standard chess with a hair trigger: put the enemy king in
check three times and you win. Every check is a point on the scoreboard,
sacrifices that would be unsound anywhere else become winning here, and
king safety is worth more than a rook.

## The rules

All standard chess rules apply. Movement, castling, en passant, promotion,
checkmate, stalemate and the usual draws. One rule is added:

1. **The third time you check the enemy king, you win immediately.**
   Checkmate also still wins, as in chess.

Details worth knowing:

- A **double check counts as one** check. Checks are counted per move, not
  per attacking piece.
- The check must be real: the move must be legal and leave the enemy king
  attacked. Discovered checks count like any other.
- Checks you *deliver* are what count; there is no penalty for being
  checked beyond the score. Both players' counts are tracked separately.

Moves are written in SAN; every `+` in the move list is a point scored.

## Reading the board

Next to each clock the app shows a **check counter**. Three pips per
player, filling as checks are given. Read it the way you read material: a
two-check deficit outweighs a piece. Everything else is the standard chess
board with SAN move list and check highlighting.

```position
rnbq1bnr/pp2pk1p/3p2p1/2p4Q/4P3/8/PPPP1PPP/RNB1K1NR w KQ - 1+3 0 5
```

*White to move has given two checks; the third: Qd5+, sliding along the
fifth rank. Wins on the spot.*

## Three principles

1. **A check is worth roughly a pawn. A cheap check is worth more.** Grabbing
   material while your opponent banks checks is how beginners lose. When
   comparing moves, treat "gives a safe check" or "prevents a check" as
   material gain.
2. **Blunt the diagonals to your king early.** Most quick checks arrive via
   Bb5/Bc4 (or ...Bb4/...Bc5) and the queen on the h5–e8 or a5–e1 lines.
   Moves like ...e6, ...c6, a3 and c3 look modest and are theory here: they
   price checks out of the position.
3. **Sacrifice to open the king once two checks are banked.** With two
   checks scored, any sacrifice that forces one more check is winning by
   definition. Endgames flip the same way: a lone queen against a bare king
   almost always harvests a check per move. Three-check endings are races,
   not grinds.

## A classic pattern or trap

The classic punishment sequence targets f7 the moment Black plays a slow
first move. After **1. e4 c5?** (the Sicilian; respectable in chess,
already dubious here) **2. Bc4 d6??** Black never gets a third move:

**3. Bxf7+!** (check one) **3... Kxf7 4. Qh5+** (check two) **4... g6**,
and now the quiet killer, **5. Qd5+**, gliding along the fifth rank the
...g6 block just cleared. Third check, game over. The position above shows
the moment before the final blow. Note what White paid: one bishop, for a
pawn and the game.

If Black tries 4... Ke6 instead, 5. Qf5+ ends it just as fast; 4... Kf6
walks into 5. Qf3+ ideas. Every road pays the third toll.

The pattern to keep: **a sacrifice on f7/f2 converts material into two
forced checks**, and two forced checks with the queen still aboard is
usually the whole game. The defense is equally memorable: never leave f7
guarded only by the king in the opening. Meet 2. Bc4 with 2... e6, and
answer early queen-and-bishop batteries by blocking with tempo, not by
grabbing pawns.
