# Othello

Othello (reversi) is the game of the last laugh: discs flip colors dozens
of times, huge leads evaporate in two moves, and the only count that
matters is the one after the final disc lands. It is a game about
mobility, patience, and real estate, especially four particular squares.

## The rules

The board is **8×8**. Discs are black on one side, white on the other.
The game begins with four discs crossed in the center. White on d4 and
e5, Black on d5 and e4, and **Black moves first**.

```position
size: 8x8
black: d5 e4
white: d4 e5
next: black
```

- **Placing.** On your turn, place a disc of your color on an empty square
  so that in at least one direction (horizontal, vertical or diagonal)
  your new disc and another disc of yours **bracket an unbroken line of
  enemy discs**. Every enemy disc so bracketed: in *every* qualifying
  direction: flips to your color.
- **You must flip.** A placement that flips nothing is illegal. If you
  have no legal move, you **pass** (the app passes for you); your opponent
  keeps moving until you have a move again.
- **Game end.** When neither player can move (usually a full board), discs
  are counted: **most discs wins**; equal counts draw.

Moves are recorded as the coordinate of the placed disc (`d3`); a forced
pass is recorded as `pass`.

## Reading the board

The app highlights your legal moves. A small hint with strategic teeth:
*count* those highlights, yours and (on your opponent's turn) theirs,
because the number of legal moves is the best single measure of who is
winning. The four **corners** (a1, a8, h1, h8) are the promised land: a
corner disc can never be flipped, and it stabilizes every disc it anchors
along edges and diagonals. The squares beside a corner, the **C-squares**
(edge-adjacent, like b1) and above all the **X-squares** (diagonal, like
b2), are correspondingly poisonous while the corner is empty.

## Three principles

1. **Minimize your discs in the middlegame.** The most counterintuitive
   truth in Othello: a wall of your color is a *liability*. It gives your
   opponent targets and you nothing to flip. Fewer discs, especially fewer
   **frontier** discs (those touching empty squares), means more moves for
   you and fewer for them. Greedy flipping loses.
2. **Play for mobility, force their hand.** Choose moves that leave you
   many follow-ups and your opponent few. When their legal-move list
   shrinks to junk squares only, they must hand you a corner. That is
   Othello's version of zugzwang, and top players engineer it deliberately.
3. **Corners are won by tempo, not by wishing.** You take a corner when
   your opponent runs out of safe moves, or when they blunder an X- or
   C-square. Track *parity* late in the game: try to make the last move in
   each empty region, and keep an odd number of moves in reserve for
   yourself in the final quadrant.

## A classic pattern or trap

The oldest self-inflicted wound in Othello is the **X-square gift**. The
X-squares (b2, g2, b7, g7) sit diagonally against the corners, and a
disc placed there almost always dies for the corner behind it.

```position
size: 8x8
black: c3 d3 e3 c4 d4 e4 c5 d5 e5
white: f5 f6 e6
next: white
```

White, feeling crowded, plays **g7?** It looks safe, deep in home
territory. But the disc now stands on the h8 diagonal. As the fight
continues, Black arranges a line of white discs between his own disc on
that diagonal and the empty corner, and one placement on **h8** flips
straight through g7. From h8, the corner disc can never be flipped; it
anchors the h-file and the eighth rank; edge discs that lean on it become
permanent. Twenty moves later the whole southeast quarter of the board is
black, and White's "safe" g7 was the hinge of the collapse.

The practical rules that follow: never play an X-square while its corner
is empty unless you have *calculated* the corner exchange; hand your
opponent X- and C-squares as their only legal moves when you can; and
when an opponent does take a corner off your blunder, don't compound it.
Corners win regions, not games, and the disc count at move 60 is the only
scoreboard.
