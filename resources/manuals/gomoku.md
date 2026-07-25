# Gomoku

Gomoku (five in a row) is the purest race in board games: no captures,
no promotions, just stones accumulating on a grid until someone lines up
five. It takes thirty seconds to learn and rewards pattern vision like
nothing else; the shapes you master here (open threes, fours, double
threats) reappear in every connection game ever made.

## The rules

The board is a **15×15** grid and stones are placed on the intersections,
never moved and never captured. **Black plays first**; players alternate,
one stone per turn, placing on any empty intersection.

- **Winning.** The first player to get **five or more** of their stones in
  an unbroken line (horizontally, vertically, or diagonally) wins
  immediately. (We play the *freestyle* rule: lines longer than five count
  too.)
- **Draw.** If the board fills with no five, the game is drawn. Draws are
  rare in practice.
- There are no other rules. No ko, no captures, no passing.

Moves are recorded as coordinates: files **a–o** and ranks **1–15**, so
`h8` is the center point.

```position
size: 15x15
black: h8
white: i9
next: black
```

## Reading the board

The app marks the last stone played and, when the game ends, highlights
the winning line. There is nothing hidden on a gomoku board, but there is
a vocabulary worth reading positions with: a **three** is three stones in
a line that can become a four; an **open three** has *both* ends empty; a
**four** threatens five and must be answered *this move*; an **open four**
(both ends empty) is unstoppable. Two winning points, one reply. Scan for
these shapes on every turn, for both colors.

## Three principles

1. **Threats first, territory never.** A stone that doesn't create or
   answer a threat is usually wasted. Each move, list your opponent's
   fours and open threes before considering your own plans. A missed four
   loses instantly, a missed open three loses in two moves.
2. **Build where lines cross.** Strength in gomoku is stones that serve
   two or three potential lines at once. Play close to your own stones
   (distance one or two), favor intersections where a row, column and
   diagonal of yours meet, and keep your shapes connected as they grow.
3. **Attack with forcing chains.** Winning attacks are sequences of fours
   and open threes that never give the defender a free move: each threat
   must be blocked, and the blocks let you build toward a double threat.
   If your sequence contains one non-forcing move, assume the defense gets
   there first: count it out before you start.

## A classic pattern or trap

Every gomoku game between beginners ends the same way: the **double open
three**. One stone creates two open threes at once; the opponent can block
only one; the other becomes an open four; the open four becomes five.

```position
size: 15x15
black: f6 g7 h6 h7 h8
white: g6 i6 j8 f9
next: white
```

Black's last stone, **h8**, finished two threes at once: the diagonal
**f6–g7–h8**, open at both e5 and i9, and the column **h6–h7–h8**, open
at both h5 and h9. White can block only one line. Say White plays h9 to
stop the column. Black answers **i9**, and the diagonal becomes an open
four (f6 through i9, with e5 and j10 both empty): two winning points, one
white stone to cover them. Black wins next move, and
the loss was already decided two moves ago.

The defensive lesson is stronger than the attacking one: **block threes
early (before they are open on both ends**) and when you must choose,
block the line that intersects the enemy's other stones, since that is
where the next fork is growing. The attacking lesson: don't chase five
directly; build crossings quietly, and let one stone finish two shapes.
