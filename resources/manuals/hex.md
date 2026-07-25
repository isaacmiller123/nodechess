# Hex

Hex is the connection game mathematicians fell in love with: two players,
one goal each, and a beautiful theorem underneath: **the game cannot end
in a draw**. Someone's chain always gets through. Stones never move and
are never captured; every placement is forever, and every game is a single
argument about one question: whose wall crosses whose?

## The rules

The board is an **11×11 rhombus of hexagonal cells**. Each player owns a
pair of opposite edges: **Black connects the top edge to the bottom edge;
White connects the left edge to the right edge**. The four corner cells
belong to both adjacent edges.

- **Black moves first.** Players alternate placing one stone of their
  color on any empty cell. Stones never move and are never captured.
- **Winning.** You win the moment an unbroken chain of your stones.
  Neighbors are the six cells touching a hexagon. Links your two edges.
- **No draws.** A completely filled board always contains exactly one
  winning chain; one player *must* win. There is no stalemate, no
  repetition, nothing to adjudicate.
- **The swap rule.** Going first is a large advantage (with perfect play,
  a proven win). To balance it, hex is traditionally played with the *pie
  rule*: after Black's first stone, White may either reply normally or
  **swap**: take over that first stone as their own. Under swap, a wise
  first move is deliberately modest.

Moves are recorded as cell coordinates, files **a–k** and ranks **1–11**
(`f6` is the center cell).

```position
size: 11x11
black: f6
white: c2
next: black
```

## Reading the board

The rhombus leans: each cell's six neighbors are left, right, above-left,
above-right, below-left and below-right. Your target edges are tinted in
your color along the border. There is no capture and no material count.
Read the board purely as **connections**: chains of stones, and pairs of
stones that are not yet touching but cannot be cut (see the bridge,
below). The app marks the last move; trace both players' shortest paths
edge-to-edge every turn.

## Three principles

1. **The center is the strongest cell on the board.** Central stones serve
   both directions of your connection and radiate influence everywhere.
   Opening theory in one line: play centrally, and swap if your opponent
   takes the center first.
2. **Defense is offense.** Every stone that blocks the enemy's crossing is
   one of yours pointing along your own. Don't build your chain and their
   blockade separately: the best moves do both at once, which is why hex
   games are won *across* the opponent's main line, not around it.
3. **Connect loosely, then solidify.** Beginners lay stones adjacent like
   bricklayers; strong players leap two or three cells using safe
   connection patterns and only fill them in when challenged. Distance
   covered per stone is the whole economy of the game.

## A classic pattern or trap

The fundamental pattern of hex is the **bridge**. Two stones a knight's
whisper apart that are *already connected*, though they don't touch.

```position
size: 11x11
black: e6 f7
white: d9
next: white
```

Black's stones on e6 and f7 share **two common empty neighbors**: f6 and
e7. If White intrudes on one, Black simply takes the other, and the chain
is whole. No single white move can sever a bridge. It is a connection
paid for now and delivered later, covering two rows for the price of one
stone.

Whole games are built from bridge chains: a ladder of bridges crosses the
board twice as fast as adjacent stones, and each one holds as long as you
**answer every intrusion immediately**: the classic trap is a bridge
owner who ignores an intrusion for one move (there is now only one
connecting cell, and the opponent takes it, cutting the chain in two).
The deeper habit the bridge teaches is hex's grand theme: *connection is
about the pair of options, not the stone*. Whenever you can arrange two
independent ways to link your groups, the link already exists; whenever
your opponent's link rests on a single cell, that cell is your next move.
