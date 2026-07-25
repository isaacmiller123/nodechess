# Connect Four

Connect Four is gravity's board game: discs drop, stack, and lock into
place, and the first line of four wins. It feels like a toy and plays
like a knife fight. The game is solved, the margins are exact, and one
lazy drop in the opening is often the whole story.

## The rules

The board is a vertical grid of **7 columns (a–g) by 6 rows (1–6)**.
Players take turns dropping one disc of their color into any column that
isn't full; the disc falls to the **lowest empty cell** of that column.
The first player is shown as Black in our app (classically the red
discs), the second as White (yellow).

- **Winning.** Four or more of your discs in a straight line. Horizontal,
  vertical, or diagonal: wins immediately.
- **Draw.** If all 42 cells fill with no four, the game is drawn.
- That's the entire rulebook: no captures, no removals, and you cannot
  pass. Every turn drops a disc somewhere.

Moves are recorded as the landing cell (`d1`, then `d2` if the same
column is used again); since the row is forced by gravity, reading just
the column letters reproduces the game.

```position
size: 7x6
black: d1
white: d2
next: black
```

## Reading the board

Discs stack from the bottom row (1) upward. Read threats by **cells, not
lines**: a threat is a specific empty cell that would complete a four.
Crucially, a threat only fires when its cell becomes *playable*. When
the column has filled up to just beneath it. That timing is the hidden
dimension of Connect Four: a threat high in a column is a landmine that
waits, and whoever is forced to fill the cell beneath an enemy landmine
detonates it. Count whose landmines sit on **odd rows** (1, 3, 5) and
whose on even: with normal play the first player tends to be handed the
odd cells and the second player the even ones, which is why endgames feel
predestined.

## Three principles

1. **The center column is worth the game.** Every four through the middle
   uses column d; the center cell participates in more winning lines than
   any other. Open with d. The game is mathematically won for the first
   player starting there, and drawn or lost starting elsewhere, and fight
   for central stacks all game.
2. **Answer threats before making prettier ones.** A vertical three is a
   one-move loss if ignored; a horizontal three open on both sides already
   *is* a loss. Before each drop, scan the opponent's completions of every
   three; the game punishes a single skipped scan with checkmate-like
   finality.
3. **Never fill the cell below a threat.** Each drop makes exactly one new
   cell playable: the one above it. If that cell completes an enemy four,
   your move was a self-destruct button. When all your safe columns run
   out, the loss is called *zugzwang*, and good opponents build toward it
   deliberately.

## A classic pattern or trap

The beginner-killer is the **open-ended three on the bottom row**. Black
opens in the center; White wanders off to the edge, twice:

1. **d1** a1 2. **e1** a2?? 3. **c1!**

```position
size: 7x6
black: d1 e1 c1
white: a1 a2
next: white
```

Black's c1–d1–e1 now stares out of the diagram with **two** completion
cells, b1 and f1, both immediately playable. White can block only one;
the other lands next turn. The game lasted six discs.

The pattern scales beyond the opening: any three with *two playable*
completion cells is unanswerable, so the real skill is seeing the shape
one move earlier. Two adjacent discs with **both wing cells empty and
playable** (like d1–e1 with c1 and f1 open) is already the trap loaded.
White's second move had to contest the bottom row (c1, f1, or a central
reply); edge-column daydreaming handed Black a textbook double threat.
When you can't win a race, don't leave the track: every reply to an
active center is either central or a block.
