# International Draughts

International (Polish) draughts is the 10×10 heavyweight of the checkers
family: twenty men a side, men that capture backward, kings that fly the
length of a diagonal, and a rule that forces you to take the *longest*
capture available. Combinations here reach five, six, seven pieces deep.
It is the most tactical game in this library.

## The rules

The board is **10×10**; play is on the 50 dark squares, double corner to
each player's right. Each player starts with **20 men** on the dark squares
of their first four rows. **White moves first.**

```position
size: 10x10
black-men: b10 d10 f10 h10 j10 a9 c9 e9 g9 i9 b8 d8 f8 h8 j8 a7 c7 e7 g7 i7
white-men: b4 d4 f4 h4 j4 a3 c3 e3 g3 i3 b2 d2 f2 h2 j2 a1 c1 e1 g1 i1
next: white
```

- A **man** moves one square diagonally **forward**. But it **captures in
  all four diagonal directions**: backward jumps are legal and common.
- **Captures are mandatory**, multi-jumps must be completed, and. The
  signature rule: you must play the sequence that captures the
  **maximum number of pieces** (count pieces only; a king in the count is
  worth no more than a man). With two equal-length options you choose.
- **Captured pieces stay on the board until the jump sequence ends** and
  are removed together afterward. They still block movement, and **no
  piece may be jumped twice** in one sequence: this "dead piece" rule
  (the *coup turc*) shapes many combinations.
- **Kings.** A man ending its move on the far row is crowned. A **king
  flies**: it moves any distance along a diagonal; it captures by jumping
  an enemy piece anywhere on the diagonal (with empty squares between)
  and may land on **any** empty square beyond it. Then must continue if
  another capture is available from the landing square. A man that merely
  *passes through* the last row mid-capture does **not** promote; only
  ending there crowns it.
- **Winning and drawing.** A player with no legal move loses. Draws come
  by agreement or repetition, and long king endings are adjudicated drawn
  when no progress is possible.

Moves are recorded from-square to to-square; the traditional notation
numbers the dark squares 1–50 (`32-28`, captures `28x19`).

## Reading the board

Kings are shown stacked. Because of the maximum-capture rule, the app only
offers the longest sequences. When your intended jump won't register,
count again: somewhere on the board a longer chain exists and you are
required to take it. In over-the-board mode the board rotates so forward
is up for the player to move.

## Three principles

1. **Count chains before contact.** Every touching of the two armies
   creates capture geometry in four directions per man. Before advancing
   into contact, trace the longest chain for both sides. Being *forced*
   into a bad capture is how most games are lost.
2. **The center is worth a tempo, the edges half a man.** Edge men have
   half the capture directions and none of the escape routes. Fight
   through the middle, and develop your rear ranks evenly. Holes behind
   your front line become landing pads for enemy multi-jumps.
3. **Respect the first king.** A flying king controls a whole diagonal
   and swings endgames single-handedly. Racing a man to promotion, even
   at the cost of two men, is often correct, and *preventing* the
   opponent's first king is worth the same price.

## A classic pattern or trap

The defining trap of international draughts is the **majority-rule shot**:
you cannot decline a capture, and you cannot even choose a shorter one,
so a clever opponent chooses it for you. White to move:

```position
size: 10x10
white-men: c3 e7 g7
black-men: b4 d4 d6 b8 a9
next: white
```

White has three possible captures: the single jump c3×b4, the single jump
e7×d6, and the double **c3×e5×c7** (over d4, then over d6). The law of
the maximum decides: White **must** play the double, ending deep on c7.
Note the quiet workhorse on a9: without it, White's chain would continue
over b8: a capture only stops when no jump remains, and a landing square
occupied by *any* piece closes the road. Now it is Black's turn to obey
the same law, and the b8 man reaps the whirlwind: **b8×d6×f8×h6**. Over
the white man now on c7, onward over e7, and again over g7. Three white
pieces removed in a single sweep.

Net result: White "won" two men and lost three, and Black's man sits
poised on h6. The position was a minefield built from White's obligations.

This is the grammar of all international draughts combinations: **feed the
maximum-capture rule a chain that ends where you want the enemy piece to
stand.** When you attack, build the runway before you offer the first
man; when you defend, examine every capture you might be *forced* to make
and ask where it parks your piece. Because your opponent already has.
