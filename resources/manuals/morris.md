# Nine Men's Morris

Nine men's morris is the mill game. A medieval classic scratched into
cathedral cloisters and Viking ship decks. Three aligned men form a
*mill*, each new mill removes an enemy man, and the game glides through
three distinct phases: place, move, fly. It is small, sharp, and far
trickier than its folk-game looks.

## The rules

The board is three concentric squares joined by four cross-lines.
**24 points** in all, named here by coordinates a1–g7 (only the marked
points exist; the center d4 does not). Each player has **nine men**;
White moves first.

```position
size: 7x7
points: a1 d1 g1 b2 d2 f2 c3 d3 e3 a4 b4 c4 e4 f4 g4 c5 d5 e5 b6 d6 f6 a7 d7 g7
white: d1 d2
black: a4 d6
next: white
```

**Phase one: placing.** Players alternate placing one man from hand onto
any empty point, eighteen placements in all.

**Phase two: moving.** Once all men are placed, a turn moves one of your
men **along a marked line to an adjacent empty point**.

**Phase three: flying.** A player reduced to exactly **three men** may
"fly": move a man to *any* empty point, adjacency ignored.

**Mills.** Whenever your move (or placement) lines up three of your men
along a single marked straight line, you have closed a **mill** and
immediately **remove one enemy man** of your choice. With one
restriction: a man inside an enemy mill may only be taken if *all* enemy
men stand in mills. Mills may be broken and re-closed: stepping a man out
of a mill and back in on a later turn forms a *new* mill, with a new
removal. Only the three points on one line count. Diagonals don't exist.

**Ending.** You lose when you are reduced to **two men**, or when it is
your turn and you have **no legal move** (all your men blocked). Draws
arise by repetition or agreement: endless shuffling with no mill in
prospect is drawn.

Moves are recorded as placements (`d5`), moves (`d5-e5`), with a removal
appended after a mill (`d5-e5 xb4`).

## Reading the board

Only the 24 marked points are playable; the lines between them are the
roads your men travel in phase two. The app shows your men in hand during
placement and highlights a closed mill while you choose the removal.
Watch the four **cross-points**: d2, b4, f4 and d6, the midpoints of the
middle square: each connects four ways, twice the mobility of a corner.

## Three principles

1. **Placement is the game.** Most defeats are sealed before the first
   move-phase turn. Place for **intersections**: points that sit on two
   potential mill lines, and deny your opponent the same. Blocking their
   forming mill with a man that also builds toward yours is the ideal
   placement, every time.
2. **Mobility beats material (almost).** A man up means little if your
   men are jammed in a corner. Before every phase-two move, count each
   side's legal moves; steering the enemy toward **zero moves** is a full
   win condition, and cramped positions collapse fast. Corners have two
   exits; cross-points have four. Occupy accordingly.
3. **Build the swinging door.** The winning engine of phase two is a man
   that steps out of a mill one turn and back in the next, or, deadlier,
   a man shuttling between **two adjacent mill lines**, closing one on
   every single turn. Each swing removes an enemy man for free. Once a
   safe swing is running, the game harvests itself; deny your opponent
   the shape at any material cost short of a mill.

## A classic pattern or trap

The classic placement trap is the **double mill threat**, morris's fork.
Watch White's third and fourth placements: holding **a1 and d2**, White
places on **d1**, the point where the bottom edge (a1–d1–g1) and the
lower cross-line (d1–d2–d3) intersect.

```position
size: 7x7
points: a1 d1 g1 b2 d2 f2 c3 d3 e3 a4 b4 c4 e4 f4 g4 c5 d5 e5 b6 d6 f6 a7 d7 g7
white: a1 d2 d1
black: b6 f6
next: black
```

White now threatens two mills at once: **g1** completes a1–d1–g1, and
**d3** completes d1–d2–d3. Black can block only one point per turn. Next
turn White closes the other mill and removes a black man. A permanent,
free tempo taken in the opening's first exchanges, usually convertible
into a second fork while Black repairs the damage.

The pattern to absorb runs both directions. Offensively: place your first
men on lines that *cross*, so one later placement threatens two lines.
Defensively: when your opponent owns two men on intersecting empty lines,
**take the intersection point yourself** before the fork exists. In the
diagram, Black should have claimed d1 a move earlier. In morris, as in
tic-tac-toe grown up, the fork is the whole tactical alphabet: every
removal you ever suffer traces back to an intersection you let slip.
