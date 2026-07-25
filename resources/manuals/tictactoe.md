# Tic-tac-toe

Tic-tac-toe is the smallest real game in this library. Nine cells, at
most nine moves, and a complete strategy you can hold in your head. That
is exactly why it's worth ten minutes of study: it is the cleanest
possible introduction to threats, forks, and the discipline of checking
your opponent's plans before advancing your own. Master it and you will
never lose a game again, literally.

## The rules

The board is a **3×3 grid**, columns **a–c**, rows **1–3**. The first
player plays **X** (shown as Black in our app), the second **O** (White),
alternating one mark per turn on any empty cell. Marks never move and are
never removed.

- **Winning.** Three of your marks in a straight line. Any row, column,
  or either diagonal (eight lines in all): wins immediately.
- **Draw.** If all nine cells fill without a line, the game is drawn.
  With correct play by both sides, a draw is the guaranteed result.

Moves are recorded as the cell placed on: `b2`, `a1`, `c3`...

```position
size: 3x3
black: b2
white: a1
next: black
```

## Reading the board

Nothing is hidden; what's worth *reading* is line arithmetic. Each cell
belongs to a fixed number of the eight winning lines: the **center** (b2)
sits on four, each **corner** on three, each **edge** (a2, b1, b3, c2) on
only two. That one sentence is most of tic-tac-toe theory. The app marks
the last move and highlights the winning line at game end.

## Three principles

1. **Center first, corners second, edges last.** Value follows line
   count: take b2 if you can, prefer corners to edges always. As the
   second player, answer a corner opening with the **center**. It is the
   only non-losing reply.
2. **Scan before you plan.** Every turn, in order: can I complete a line
   *now*? If not: can my opponent complete one next turn? Block it. Only
   then look for building moves. All tic-tac-toe losses are failures of
   this two-question scan.
3. **Play for the fork, defend the fork.** A single threat gets blocked;
   the game is won only by creating **two threats at once**. Symmetrically,
   when defending, prefer blocks that *also* build a threat of your own.
   Forcing your opponent to respond denies them the free move a fork
   needs.

## A classic pattern or trap

The one trap every human falls for once: the **double-corner fork**. X
opens in a corner. Say **a1**. O correctly takes the center, **b2**. Now
X takes the *opposite* corner, **c3**:

```position
size: 3x3
black: a1 c3
white: b2
next: white
```

The position looks harmless: X's corners are separated by O's center, so
the a1–c3 diagonal is dead. But watch what happens if O now plays the
natural-looking corner, say **a3?**. X answers **c1!**, and suddenly two
lines carry two X marks with an empty third cell: the bottom row
(a1–b1–c1, needing b1) and the right column (c1–c2–c3, needing c2). O can
block only one. X wins on the next move.

O's only correct reply to the opposite-corner setup is an **edge**:
a2, b1, b3 or c2, which looks passive and is precisely why beginners
never play it. (An edge move creates an immediate O threat through the
center, and answering it costs X the tempo the fork requires.)

Learn the shape from both sides: as X, the corner–center–opposite-corner
sequence wins against almost everyone who hasn't read this page; as O,
remember *corner opening → take center; opposite corners → answer with an
edge*. Do that, scan your two questions every move, and the worst you
will ever do again is draw.
