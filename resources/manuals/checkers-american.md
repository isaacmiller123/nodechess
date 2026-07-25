# Checkers (American)

American checkers (English draughts) is the classic 8×8 jumping game:
simple enough to learn in a minute, deep enough that its top human players
were only dethroned by computers after decades. Every capture is
compulsory, which makes the game a chain of promises: each move you make
writes your opponent's next one.

## The rules

Play happens **only on the 32 dark squares** of an 8×8 board, oriented so
each player has a dark square on their left and the "double corner" on
their right. Each player starts with **12 men** on the dark squares of
their first three rows. **Black (the darker side) moves first**, and the
players alternate.

```position
size: 8x8
black-men: b8 d8 f8 h8 a7 c7 e7 g7 b6 d6 f6 h6
white-men: a3 c3 e3 g3 b2 d2 f2 h2 a1 c1 e1 g1
next: black
```

- A **man** moves one square **diagonally forward** onto an empty square.
- A man **captures** by jumping diagonally forward over an adjacent enemy
  piece onto the empty square directly beyond. The jumped piece is removed.
- **Captures are mandatory.** If a jump is available you must take it, and
  if the jumping piece can continue jumping from where it lands, it
  **must continue** in the same turn. When several capturing sequences
  exist you may choose freely among them. You are *not* required to take
  the most.
- **Kings.** A man reaching the far row is crowned (a second checker is
  stacked on it) and the move ends there, even if further jumps would be
  possible. A king moves and jumps one square diagonally in **any**
  direction: there are no long-range "flying" kings in the American game.
- **Winning.** You win when your opponent **cannot move**: all their
  pieces are captured, or every remaining piece is blocked. There is no
  stalemate escape: no move means you lose.
- **Draws** come by agreement or by repetition of a position neither side
  can improve (the endgame of one king chasing another around the double
  corner is the classic case).

Moves are recorded from-square to to-square; the traditional literature
numbers the dark squares 1–32, writing quiet moves like `11-15` and jumps
like `22x15`.

## Reading the board

Only the dark squares are playable, and the app dims everything else.
Kings are shown as stacked (doubled) pieces. Because captures are
mandatory, when a jump exists the app will only let you pick jumping
pieces: if a piece won't lift, look for a capture elsewhere. The board
flips in over-the-board mode so "forward" is always up from your seat.

## Three principles

1. **Every move is a lever on the capture rule.** Before moving, ask what
   jumps you are *giving* your opponent and what jumps their reply will
   give you. Strong checkers is played two forced moves ahead of the
   position on the board.
2. **Hold your back row.** Men on your crowning row deny your opponent
   kings. Keep at least two back-row men in place until the middlegame is
   decided; a premature king for your opponent usually costs you two men
   or the game.
3. **Trade when ahead, never when behind.** Forced captures make trades
   easy to engineer. Each even trade multiplies a material edge. One man
   up with six left is worth far more than one man up with twelve. When
   behind, keep the board crowded and hunt for shots instead.

## A classic pattern or trap

The bread-and-butter tactic of checkers is the **two-for-one shot**. A
sacrifice that uses the forced-capture rule to line up a double jump.
Black to move (Black plays down the board):

```position
size: 8x8
black-men: b6 e5 f6
white-men: c3 e3
next: black
```

Black plays **e5–d4!**, pushing a man directly between White's two men.
White *must* jump (that is the whole trick) and both captures lose:

- **c3×d4** lands on e5, the square Black just vacated. Black's man on f6
  now jumps it, landing on d4, and from d4 the jump **must continue**
  over e3 to f2. Two white men gone in one turn (written `f6×d4×f2`).
- **e3×d4** lands on c5 instead, and the mirror image fires: Black's b6
  man jumps to d4 and continues over c3 to b2 (`b6×d4×b2`). Same harvest
  from the other side.

One man invested, two collected, either way. This shape, a sacrifice
square where every forced recapture lands on a springboard for a multiple
jump, is called a *shot*, and nearly all checkers tactics are built from
it. Learn to see the empty squares *behind* your men as landing pads, and
audit every "free" jump your opponent offers you: in checkers, gifts
always have return postage.
