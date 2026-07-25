# Janggi (Korean Chess)

Janggi is xiangqi's Korean cousin. Same 9×10 board, same palaces, but no
river, hungrier soldiers, freer elephants, and a cannon so dangerous it is
forbidden from touching its own kind. It also has a rule almost no other
chess game has: you may **pass your turn**.

## The rules

The board is **9 files (a–i) by 10 ranks (1–10)** and pieces stand on the
intersections. There is **no river**. Each side has a 3×3 **palace**
(files d–f, ranks 1–3 and 8–10) with diagonal lines connecting its corners
through the center.

Blue (Cho) moves first (mapped to White in our app) and Red (Han)
replies. Setup from a1 to i1: chariot, horse, elephant, guard, *empty*,
guard, elephant, horse, chariot; the **general starts on the palace
center point** (e2 for Blue, e9 for Red); cannons on b3 and h3; soldiers
on a4, c4, e4, g4, i4. (Traditional play lets each player pre-swap a horse
and elephant; our app uses this standard arrangement.)

```position
rnba1abnr/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/RNBA1ABNR w - - 0 1
```

The pieces:

- **General**: one point along any marked palace line (orthogonal
  anywhere in the palace; diagonal only where diagonal lines exist), never
  leaving the palace.
- **Guard**. Moves exactly like the general, and is likewise confined.
- **Chariot**: any distance orthogonally; inside either palace it may
  also slide along the diagonal lines.
- **Cannon**: moves *and* captures by jumping over **exactly one screen**
  anywhere along an orthogonal line (or a palace diagonal). Two absolute
  bans: a cannon may **not use another cannon as its screen**, and may
  **not capture a cannon**. With no screen available, a cannon cannot move
  at all.
- **Horse**: one point orthogonal plus one diagonal outward; blocked by a
  piece on the orthogonal point (as in xiangqi).
- **Elephant** (one point orthogonal plus **two** diagonal outward) a
  long, blockable, 2×3 leap. With no river, it roams the whole board.
- **Soldier**: one point **forward or sideways** from the very start (it
  never moves backward); inside the enemy palace it may also step along
  the diagonal lines.

**Passing.** On your turn you may pass instead of moving (never while in
check). In our app the pass is recorded as the general "stepping" onto its
own point, e.g. `e2e2`.

**Ending.** Checkmate wins. Because passing is legal, there is no
stalemate. When the two generals come to face each other on an open file
(*bikjang*), tradition treats the position as a mutual draw offer, and a
game where both sides merely pass is likewise dead; engines adjudicate
such standoffs as draws. Perpetual check is forbidden.

Moves are written as coordinates: `b1c3` develops a horse, `h3e3` centers
a cannon.

## Reading the board

Blue's pieces show blue characters, Red's red; both palaces display their
X-shaped diagonal lines: read those lines as extra files for chariots,
cannons and palace-invading soldiers. Files a–i and ranks 1–10 label the
edges to match the move list. The general starts mid-palace, one step
closer to the fight than in xiangqi; a checked general is highlighted.

## Three principles

1. **Screens are infrastructure.** Nothing on a janggi board matters more
   than what your cannons can jump. The standard opening plans revolve
   around horse moves (`c1d3`, `h1g3`) that build screens, and soldier
   moves that open cannon lanes. Before every capture, recount both sides'
   cannon lines: positions change explosively when a screen appears or
   vanishes.
2. **Soldiers are worth real money.** Sideways movement from move one
   makes janggi soldiers flexible blockers and slow-rolling attackers.
   They're traditionally valued at two points against the xiangqi
   soldier's one-ish. Don't shed them casually, and use their sideways
   step to keep files closed against enemy chariots.
3. **The palace diagonals cut both ways.** A chariot or cannon that
   reaches the enemy palace corner rakes it along the diagonals, but
   your own palace's diagonals are enemy highways too. Keep a guard on the
   center point as long as you can: it plugs the diagonal crossroads and
   screens nothing important.

## A classic pattern or trap

The signature janggi geometry is the **cannon through the palace**: the
enemy's own guard, sitting on the palace center, becomes the screen that
carries your cannon's fire along the diagonal into the corner.

```position
1R1k5/2P1a4/5C3/9/9/9/9/9/4K4/9 b - - 0 1
```

Red is checkmated. Blue's cannon on f8 sits on the palace corner and
attacks along the diagonal f8–e9–d10: the red guard on e9 is the screen,
the general on d10 the target. Meanwhile the chariot on b10 checks along
the back rank. A double check, so capturing or blocking is futile. The
escape points are gone: e10 is covered by the chariot, and d9 by the
soldier on c9, poking sideways as janggi soldiers do.

Note the cruelty of the mechanism: the guard, Red's most loyal defender,
is the piece that delivers the fatal line, and it cannot even step aside,
because a double check demands a king move. This pattern is why strong
players think twice before parking pieces on the palace center against an
active enemy cannon, and why a cannon lifted to the enemy palace corner is
often worth more than a chariot's pawn-grabbing raid: the defending
cannon, remember, can never remove it, since **cannons cannot capture
cannons**. Build the geometry
first; the mate assembles itself.
