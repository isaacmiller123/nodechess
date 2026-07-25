# Atomic

Atomic is chess with explosives in every piece: each capture detonates,
wiping out everything (except pawns) around the capture square, including
the capturing piece itself. Games are short, violent, and decided by whoever
understands one idea first: the king dies to blasts, not just to mate.

## The rules

Setup and piece movement are exactly as in standard chess, and checkmate
still wins. The differences:

1. **Every capture explodes.** When any piece captures, remove from the
   board: the captured piece, the **capturing piece itself**, and every
   piece on the eight squares surrounding the capture square, **except
   pawns**. Pawns only die when they are directly captured (or do the
   capturing). For en passant, the blast is centered on the square the
   capturing pawn lands on.
2. **Blow up the king to win.** If an explosion destroys the enemy king,
   the game ends immediately: even if the move exposes or checks your own
   king. Destroying your own king in a blast is illegal, which means you may
   never capture anything adjacent to your own king.
3. **Kings cannot capture** (they would die in their own explosion).
4. **Touching kings are safe.** Because no capture may destroy your own
   king, a king standing next to the enemy king cannot be exploded, all
   "checks" evaporate while the kings touch. Walking your king up to your
   opponent's is a real defensive resource.
5. Castling, promotion and en passant are otherwise unchanged. Draws by
   stalemate, repetition and agreement are as in chess.

Moves are written as in standard chess; the app's move list uses SAN, and a
capture entry like `Nxf7` implies the whole explosion.

## Reading the board

The board reads like a standard chess board. Coordinates, SAN move list,
last-move highlight. After a capture the app clears the blast zone in one
animation; take a second to re-read the position afterward, because up to
nine pieces can vanish in a single move. A king in danger of being exploded
is highlighted like a check.

## Three principles

1. **Count blast radii before material.** A defended piece is *not* safe.
   The attacker dies in the blast anyway, and trades are never one-for-one.
   Before any capture, list everything inside the nine squares. "Winning a
   pawn" that vacates the shield next to your king loses games.
2. **Guard f7 and f2 with your life.** A knight capturing on f7 explodes
   the e8 king. Until your king moves or the f-pawn is safely advanced,
   every enemy knight hop toward g5/e5 (or g4/e4 against you) is a mating
   threat that **cannot be met by defending f7**. Defenders don't matter,
   only removing the target or the attacker does.
3. **Pawns are armor.** Since explosions spare pawns, an intact pawn shell
   is the best king safety in the game, and your opponent's pawns cannot
   be blasted away, only captured one by one. Keep your shell; pry theirs
   open with direct pawn captures.

## A classic pattern or trap

The defining atomic opening trap punishes the most natural developing move
in chess. After **1. Nf3**, the reply **1... Nf6??** loses by force:
**2. Ng5!**

```position
rnbqkb1r/pppppppp/5n2/6N1/8/8/PPPPPPPP/RNBQKB1R b KQkq - 3 2
```

White threatens 3. Nxf7. The blast at f7 destroys the king on e8 and ends
the game on the spot. Nothing stops it: defending f7 is useless (rule 1),
the king has no flight square, and. The cruel detail. Black's own knight
on f6 blocks the f-pawn, so neither ...f6 nor ...f5 can vacate the target
square. Even the counterattack 2... Ne4, racing for a blast on d2 next to
White's king, is one tempo too slow: 3. Nxf7 ends the game first.

This is why real atomic theory begins **1. Nf3 f6!** Moving the f-pawn
early so there is nothing on f7 to capture. Remember the shape of the trick:
*any* piece that can reach a capture next to your king is a one-move win,
and only removing the target or the attacker helps. Scan for it every move,
on both sides of the board.
