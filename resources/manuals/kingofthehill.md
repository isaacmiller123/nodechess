# King of the Hill

King of the Hill is standard chess with a second way to win: walk your own
king to the center of the board. The four "hill" squares turn the weakest
piece into a race car, and every endgame (and plenty of middlegames) into
a sprint.

## The rules

All standard chess rules apply. Movement, castling, en passant, promotion,
check, checkmate and every draw rule. One rule is added:

1. **If your king legally reaches d4, d5, e4 or e5, you win instantly.**

Everything else follows from the word *legally*: the king still may not
move into check, so the hill must be reached through squares your opponent
does not control. Checkmate still wins as usual, and a stalemated player
still draws. The hill rule simply adds a finish line.

```position
rnbqkbnr/1ppppppp/8/8/p2KP3/8/PPPP1PPP/RNBQ1BNR b kq - 1 4
```

*White to move played Kd4 here. Game over, no matter that Black's whole
army is still on the board.*

Moves are written in standard SAN in the move list, exactly as in chess.

## Reading the board

The four hill squares (d4, d5, e4, e5) are marked on the board so you can
never lose sight of the finish line. Otherwise the board reads as standard
chess: coordinates, SAN move list, last-move and check highlights. When
either king crosses onto its third rank, treat the position as a live race
and start counting tempi.

## Three principles

1. **Control the hill with pieces, not hopes.** A king cannot step onto a
   square you attack. Long-range pieces aimed through the center (bishops
   on long diagonals, rooks on the d- and e-files) are fences; keep at
   least two center squares covered at all times, even while attacking.
2. **Count the race before trading queens.** Every exchange makes the
   king-march safer: for both sides. Before each trade, count in tempi:
   how many moves does each king need to reach a hill square it can
   actually stand on? If you're behind in the race, keep pieces on.
3. **Checks are turbo boosts. For the defender too.** A well-timed check
   gains a tempo on a racing king or drives it backward. Conversely, when
   *your* king runs, pick a path with squares where no check lands. The
   center pawns you push early decide which paths exist.

## A classic pattern or trap

The instructive disaster is the **premature king march**. Against passive
play the march is embarrassingly fast: 1. e4 a6 2. Ke2 a5 3. Ke3 a4
4. Kd4 and the game is over in four moves. But the same idea one tempo too
early is a losing lunge: after **1. e4 e5 2. Ke2??** Black strikes with
**2... Qh4!**

```position
rnb1kbnr/pppp1ppp/8/4p3/4P2q/8/PPPPKPPP/RNBQ1BNR w kq - 2 3
```

The queen eyes both e4 and f2; the white king has burned castling, blocks
its own bishop and queen, and every developing move Black makes now comes
with tempo against the stranded monarch. White is not losing a race. White
has left the starting blocks in the wrong direction, and pieces will arrive
at the white king long before the white king arrives anywhere.

The pattern generalizes to every King of the Hill game you'll play: the
march wins when the board is **quiet or simplified**, and loses when the
opponent's pieces are still aimed at the center. Develop first, fence the
hill, trade on your terms. Then run.
