# Go

Go is the oldest board game still played in its original form, and the
simplest great game ever designed: place stones, surround territory,
surround enemy stones. The rules fit on a postcard; the consequences have
filled four thousand years.

## The rules

The board is a grid of lines: **19×19** for the full game; **9×9** and
**13×13** are standard for learning, and stones are placed on the
**intersections**, including edges and corners. **Black plays first**;
players alternate, one stone per turn, and stones **never move** once
placed. Instead of placing a stone you may **pass**.

- **Liberties.** An empty intersection directly adjacent (up, down, left,
  right) to a stone is a liberty. Stones of one color that touch each
  other form a **group** and share their liberties.
- **Capture.** When a group's last liberty is filled, the whole group is
  removed from the board and kept as prisoners.
- **No suicide.** You may not place a stone that leaves its own group
  with zero liberties: unless the placement captures enemy stones first
  (their removal gives your stone its liberty).
- **Ko.** A stone may not recreate the immediately previous whole-board
  position (the classic case: two single stones capturing each other back
  and forth forever). You must play elsewhere for one move before
  retaking. Our app enforces the general form: no earlier whole-board
  position may ever recur.
- **Game end and scoring.** Two consecutive passes end the game. The
  players then mark **dead stones**: stones that could not escape
  capture, which are removed as prisoners. The app supports both
  classical scoring systems: **territory scoring** (Japanese; your empty
  surrounded points plus prisoners you took), and **area scoring**
  (Chinese: your empty surrounded points plus your living stones on the
  board). White receives **komi**. Compensation points for moving second,
  typically 6.5 (territory) or 7.5 (area); the half point prevents ties.
  Highest total wins.

Moves are recorded as coordinates (`d4`), with `pass` written out.

## Reading the board

Star points (the dotted intersections) are only landmarks. They have no
rule meaning. The app shows the last move marked, prisoners counted beside
each clock, and during scoring it shades each player's territory and lets
you toggle dead groups. On the small boards a full game takes minutes;
learn there first, every principle scales up.

## Three principles

1. **Corners, then sides, then center.** Territory is cheapest where the
   board's edges help enclose it: a corner needs two walls, a side three,
   the center four. Open on the star points or the 3-4 points in the
   corners; treat the center as a battlefield, not a farm.
2. **Stay connected; keep liberties.** A group's strength is its liberty
   count and its connection to friends. Don't let groups get surrounded
   and don't touch strong enemy stones without a plan. Contact moves
   strengthen the defender. Before every fight, count liberties like a
   pilot counts fuel.
3. **Two eyes live.** A group enclosing two *separate* empty points can
   never be captured. The opponent cannot fill both at once (each would
   be suicide). Every life-and-death problem reduces to this: make two
   eyes for your groups, deny them to your opponent's.

## A classic pattern or trap

The first tactical pattern every go player must learn, usually the hard
way, is the **ladder** (*shicho*). A stone caught in a ladder can run,
but every step of the chase is forced, and the chase only ends one way.

```position
size: 9x9
black: c4 d5 e3
white: d4
next: black
```

Black plays **d3**. Atari, one liberty left. White's only escape is
**e4**, but here Black's quiet stone on e3 earns its keep: the new
two-stone chain *still* has only two liberties (e5 and f4). Black ataris
from below with **f4**; White crawls to **e5**; Black **e6**, White
**f5**; Black **g5**, White **f6**... Every extension is answered by
another atari, always on the side that bends the chase toward Black's
walls. The white chain zigzags diagonally up the board with never more
than two liberties, growing heavier at every step, and when it reaches
the edge it dies whole. A dozen stones handed over because the first one
couldn't bear to be sacrificed.

The rule of thumb: **never run a ladder that doesn't work.** Before
extending, trace the zigzag diagonally across the board: if no friendly
stone (a *ladder breaker*) sits on that path, the stone is already dead:
sacrifice it and take your compensation elsewhere. Conversely, one quiet
stone placed on the far diagonal turns the whole chase into a disaster
for the attacker, because every atari Black played becomes a stone with
its own weaknesses. Grand strategy from a two-liberty count: that is go
in miniature.
