# Antichess

Antichess turns the goal of chess inside out: you win by **losing every
piece you have**, or by having no legal move. Captures are compulsory, the
king is just another piece, and material is a burden. It sounds like a joke
variant; it plays like a razor-sharp calculation exercise.

## The rules

Setup and piece movement are as in standard chess, with these changes:

1. **Winning condition, inverted.** You win by losing **all** of your
   pieces (including the king), or by being **stalemated**. If you have no
   legal move on your turn, you win.
2. **Captures are mandatory.** If any capture is available, you *must*
   capture. When several captures are available you choose freely among
   them: there is no obligation to take the biggest piece.
3. **The king is an ordinary piece.** There is no check, no checkmate, and
   no rule against leaving the king attacked. The king can be captured like
   anything else, and a pawn may even **promote to a king**.
4. **No castling.** En passant works normally, and remains a capture, so
   it can be forced. Promotion is to queen, rook, bishop, knight **or
   king**.
5. Draws occur by agreement, threefold repetition, or dead positions where
   neither side can ever be forced to capture (the classic case: bishops of
   opposite colors on blocked diagonals).

Moves are written in SAN as usual; there is simply never a `+` or `#`.

## Reading the board

The board reads like standard chess. When a capture is available, the app
restricts you to capturing moves. If a piece refuses to go where you drag
it, look for a capture you must make instead (legal destinations are
highlighted when you pick a piece up). The material counter under the clock
is the score you are trying to drive to **zero**.

## Three principles

1. **Every piece you attack, your opponent may feed you.** Threats work
   backward: attacking an enemy piece often *helps* them, because they can
   force you to eat it and drag your pieces onto bad squares. Ask of every
   move: "what will this force *me* to capture next?"
2. **Avoid early pawn moves that open lines to your camp.** Diagonals
   pointing at your position are delivery chutes. An enemy bishop or queen
   will happily sacrifice itself deep in your camp to set up a chain of
   forced captures. Keep your position closed until you can see the whole
   sequence.
3. **Count the forced sequence to the very end.** Antichess is the most
   concrete game in this library: whole games are decided by one long
   mandatory-capture chain. Before you touch a pawn, follow every capture
   to the final position. If you can't, play something that forces nothing.

## A classic pattern or trap

The oldest lesson in antichess: **1. e4 is a losing move**, and the classic
punishment is **1... b5!**. The point is that White's bishop is now *forced*
into a feeding chain: **2. Bxb5** (compulsory; it is White's only capture)
**2... Nf6 3. Bxd7** (again the only capture) **3... Nxe4**, and now after
**4. Bxc8** Black plays the star move **4... Qxd2!**, hurling the queen into
White's camp:

```position
rnB1kb1r/p1p1pppp/8/8/4n3/8/PPPq1PPP/RNBQK1NR w - - 0 5
```

White *must* accept (any of the four recaptures on d2 is forced) and each
one pulls another white piece onto a square where Black's knight and pawns
can keep force-feeding it material. Black happily sheds queen, knight and
pawns; every unit gone is a step toward victory. Play the line out against
a bot and watch how little say White has in his own moves.

The pattern to internalize: **a piece offered deep in enemy territory is a
lever**: it forces a capture, and the capturing piece is then exposed to
the next offer. Computer analysis long ago proved 1. e4 loses by force
(remarkably, antichess is fully solved: 1. e3 wins for White). You don't
need the proof. You need the reflex of reading every forced chain before
you start one.
