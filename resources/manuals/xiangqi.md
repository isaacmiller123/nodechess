# Xiangqi (Chinese Chess)

Xiangqi is the most-played chess game on Earth: two armies divided by a
river, generals locked in palaces, and a piece (the cannon) that captures
by jumping. It is faster and more tactical than Western chess from the very
first move.

## The rules

The board is a grid of **9 files (a–i) by 10 ranks (1–10)**, and pieces sit
**on the intersections**, not in the squares. Two zones matter:

- The **river** crosses the board between ranks 5 and 6. It affects
  elephants (which cannot cross) and soldiers (which strengthen after
  crossing).
- Each side has a **palace**: the nine points where files d–f meet ranks
  1–3 (Red) or ranks 8–10 (Black), marked with diagonal lines. Generals
  and advisors never leave it.

Red (first player; shown as White in our app) sets up, from a1 to i1:
chariot, horse, elephant, advisor, general, advisor, elephant, horse,
chariot; cannons on b3 and h3; soldiers on a4, c4, e4, g4, i4. Black
mirrors this arrangement. Red moves first.

```position
rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1
```

The pieces (capturing = moving onto an enemy piece, as in chess):

- **General**: one point orthogonally, confined to the palace. Special
  rule: the two generals may **never face each other** on the same file
  with nothing between them (the "flying general" rule): a move creating
  that is illegal.
- **Advisor**: one point diagonally, confined to the palace (it only ever
  touches five points).
- **Elephant**: exactly two points diagonally; it cannot jump (a piece on
  the intermediate point blocks it) and **cannot cross the river**.
- **Horse**: one point orthogonally then one diagonally outward. A piece
  standing on the adjacent orthogonal point **blocks the move** ("hobbling
  the horse's leg"): unlike a chess knight, it does not jump.
- **Chariot**: any distance orthogonally; the strongest piece.
- **Cannon**. *moves* like a chariot, but *captures* differently: it must
  jump over **exactly one** piece of either color (the "screen") and take
  the first piece beyond it.
- **Soldier**: one point straight forward. After crossing the river it may
  also move one point **sideways**. It never moves backward and never
  promotes; on the last rank it can only shuffle sideways.

**Checkmate wins.** A player with no legal move is **stalemated and
loses** (unlike Western chess). Perpetual check is forbidden: endlessly
repeating checks loses for the checking side, and endlessly chasing an
unprotected piece is likewise not allowed. Simple repetitions without
checks or chases are drawn.

Moves in our app are written as coordinates, from-point to to-point:
`b3e3` slides the cannon to the center, `b1c3` develops the horse.

## Reading the board

The board shows the river band across the middle and the crossed diagonal
lines of both palaces; pieces are discs bearing their Chinese character
(traditional sets). Red's and Black's characters differ slightly for some
pieces, but position and movement identify them quickly. Files a–i and
ranks 1–10 label the edges, matching the coordinate move list. Your side is
at the bottom; a general in check is highlighted.

## Three principles

1. **Cannons open, horses close.** Cannons are strongest early, when the
   board is full of screens: the classic first move `b3e3` (or `h3e3`)
   aims one at the enemy's central soldier and general. Horses grow as the
   board empties and their legs stop being hobbled. Trade accordingly.
2. **Never neglect the central file.** The e-file runs straight through
   both palaces, and most mating attacks travel it. Keep a defender (horse
   or advisor structure) covering your palace's center point, and think
   twice before moving the e-file soldier.
3. **Chariots want open files fast.** A chariot that reaches an open file
   or the enemy's soldier rank in the first dozen moves often decides the
   game. Move each chariot early. A chariot still on its home point at
   move 15 is a wasted major piece.

## A classic pattern or trap

The first checkmate every xiangqi player learns is the **double-cannon
mate**: two cannons stacked on one file, where the front cannon serves as
the screen for the one behind.

```position
3aka3/4C4/6N2/9/4C4/9/9/9/9/4K4 b - - 0 1
```

Black is checkmated. The rear cannon on e5 checks the general through the
front cannon on e9. The general cannot capture the front cannon. The
white horse on g8 guards e9, and cannot sidestep, because its own
advisors fill d10 and f10. Blocking is hopeless too: any piece placed
between the cannons simply becomes a new screen.

Notice the poisoned geometry: the defenders themselves. Advisors, blockers,
even the general's protectors: feed the cannons. That is the recurring
tragedy of xiangqi defense, and the reason experienced players meet a
stacked pair of cannons on the palace file by **moving the general off the
file early or trading a cannon off at any reasonable price**. When you have
the cannons: stack them, and let your opponent's own pieces build your
mate.
