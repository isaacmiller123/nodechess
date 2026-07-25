# Shogi (Japanese Chess)

Shogi is chess where captured pieces change allegiance: everything you take
goes into your hand and can be paraded back onto the board for your side.
Armies never shrink, attacks never run out of reinforcements, and no
endgame is ever dead. It is widely considered the deepest of the classical
chess variants.

## The rules

The board is **9×9**; pieces are wedge-shaped tiles that all share both
players' colors: a piece's owner is shown by which way it points. In our
app the first player sits at the bottom (mapped to White), files are
lettered **a–i** and ranks numbered **1–9** from that player's left and
side. Each player starts with, on the back rank from the corners inward:
lance, knight, silver, gold, king (center); bishop on the second rank
(left, b2 for the first player), rook on the second rank (right, h2); and
nine pawns across the third rank.

```position
lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL[] w - - 0 1
```

Moves of the basic pieces ("forward" is toward the opponent):

- **King**: one square any direction.
- **Rook** (any distance orthogonally. **Bishop**) any distance
  diagonally.
- **Gold**: one square any direction *except* diagonally backward.
- **Silver**: one square diagonally, or straight forward.
- **Knight**: jumps two forward plus one sideways (the two forward
  L-squares only); the only jumping piece.
- **Lance**: any distance straight forward.
- **Pawn**: one square straight forward, and it **captures the same way**
  (no diagonal pawn captures).

**Promotion.** The far three ranks are your promotion zone. A move that
starts or ends inside it may promote, flipping the tile: silver, knight,
lance and pawn all promote to **gold movement**; the rook becomes a
**dragon** (rook + one-step diagonal); the bishop a **horse** (bishop +
one-step orthogonal). Promotion is optional. Except when the piece would
otherwise never move again (a pawn or lance reaching the last rank, a
knight reaching the last two), where it is forced. Golds and kings never
promote.

**Drops.** Instead of moving, you may place any piece from your hand on
any empty square, unpromoted (a promoted piece captured returns to hand as
its basic self). Three restrictions: no pawn on a file where you already
have an unpromoted pawn (*nifu*); no piece dropped where it could never
move (pawn/lance on the last rank, knight on the last two); and **no
checkmate by pawn drop** (*uchifuzume*). Mating with a *moved* pawn is
fine. A dropped piece cannot promote on the same turn.

**Ending.** Checkmate wins; a player with no legal move loses. Fourfold
repetition is a draw. Unless one side gave perpetual check, in which case
the checker loses.

Our app writes moves as coordinates: `c3c4` pushes a pawn, `b2g7+`
captures and promotes the bishop, `G@e8` drops a gold.

## Reading the board

Tiles point toward their owner's opponent; captured pieces appear in each
player's **hand tray** beside the board with counts, exactly like a
crazyhouse pocket. Promoted pieces show their promoted face (traditionally
in red). The coordinate move list matches the board labels, `+` marks a
promotion and `@` a drop. Watch both trays the way you watch material in
chess: a hand full of generals is a mating attack in storage.

## Three principles

1. **Castle your king behind golds and silvers.** There is no castling
   move; instead you build a fortress by hand. Two golds and a silver
   around a king moved two files off-center (the *Mino* shape is the
   classic) survive attacks that would end the game for a king on its
   starting square.
2. **Pawns are currency, not structure.** With no diagonal pawn captures
   there are no pawn chains. Pawns are tempo tokens: drop one to block a
   check, jab one to open a file, sacrifice one to buy a square for a
   silver. Always keep at least one pawn in hand.
3. **Attack with drops ahead of the enemy king, defend by trading the
   attackers' hand empty.** Material only matters as *usable* material:
   count what each side holds in hand before judging any exchange. Speed
   beats size: in shogi the player one move faster in the mutual mating
   race wins, and grabbing a far-away lance while your king's fortress
   burns is the classic losing plan.

## A classic pattern or trap

The first mating pattern every shogi player learns is ***atama-kin*, the
gold on the head**. A gold dropped directly in front of the enemy king,
protected by any friendly piece, is checkmate against a bare king:

```position
4k4/9/4P4/9/9/9/9/9/K8[G] w - - 0 1
```

White plays **G@e8**. Gold dropped one square in front of the king,
guarded by the pawn on e7, and the game ends. Count the escape squares:
d8, e8 and f8 are covered by the gold itself; d9 and f9 are the gold's
forward diagonals; and the king cannot capture on e8 because of the pawn
behind the gold. A single coin-sized piece, one move, mate.

This shape is the destination of nearly every shogi attack: strip the
king's defenders, get a gold (or silver) in hand, and aim it at the point
directly in front of the king. It also explains two rules at once. Why
pawn-drop mate is banned (the same idea with a pawn was judged too cheap)
and why defenders give up almost anything to keep a pawn or gold from
landing on that square. When you defend, guard the head-square first; when
you attack, undermine whatever guards it.
