# Chess

Chess is the classic duel: two armies of sixteen, one goal, trap the enemy
king. Everything else in this library descends from the rules on this page,
so it is worth reading them once, carefully, even if you have played before.

## The rules

The board is 8×8, with a **light square in each player's right-hand corner**.
Files are lettered **a–h** from White's left; ranks are numbered **1–8** from
White's side. Each player starts with eight pawns on their second rank and,
on the first rank from the a-file: rook, knight, bishop, queen, king, bishop,
knight, rook. The queen starts on her own color (white queen on d1, black
queen on d8). **White moves first**, then the players alternate; passing is
not allowed.

```position
rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
```

How the pieces move (no piece may land on a friendly piece; capturing means
moving onto an enemy piece and removing it):

- **Rook**: any distance along a rank or file.
- **Bishop**: any distance along a diagonal. Each bishop lives on one color
  forever.
- **Queen**: rook and bishop combined.
- **Knight**: an "L": two squares one way, one square sideways. It is the
  only piece that **jumps over** anything in between.
- **King**: one square in any direction. The king may never move onto a
  square attacked by an enemy piece.
- **Pawn**: one square straight forward (two from its starting square), and
  it **captures diagonally forward** only. Pawns never move backward.

Three special moves:

1. **Castling.** Once per game, king and rook move together: the king slides
   two squares toward a rook and the rook hops to the square the king
   crossed. Allowed only if neither piece has moved, the squares between them
   are empty, and the king is not in check, does not pass through an attacked
   square, and does not land on one.
2. **En passant.** If an enemy pawn advances two squares and lands directly
   beside your pawn, you may capture it *as if* it had moved one square,
   but only on the very next move.
3. **Promotion.** A pawn reaching the last rank immediately becomes a queen,
   rook, bishop or knight of your choice (almost always a queen).

A king attacked by an enemy piece is **in check** and the attack must be
answered immediately: move the king, block the line, or capture the
attacker. **Checkmate** (check with no legal answer) wins the game.
**Stalemate** (no legal move while *not* in check) is a draw. Games are
also drawn by agreement, by **threefold repetition** of the same position,
by **fifty moves** from both sides without a pawn move or capture, or when
neither side has enough material to mate (for example, king against king).

## Reading the board

The app shows the board from your side; coordinates run along the edges.
Your last move is highlighted, and a king in check glows red. The move list
uses **standard algebraic notation (SAN)**: each piece is a letter (K, Q, R,
B, N: pawns have none), `x` marks a capture, `+` a check, `#` a checkmate,
and `O-O` / `O-O-O` are kingside and queenside castling. So `Nxf6+` reads
"knight captures on f6, check."

> To castle, drag your king two squares toward the rook, or simply drop it
> onto the rook. To promote, a small picker appears over the promotion
> square.

## Three principles

1. **Fight for the center.** The four central squares (d4, d5, e4, e5) are
   the high ground: pieces placed there reach the most squares. Open with a
   center pawn and aim your pieces at the middle.
2. **Develop, then attack.** Bring knights and bishops out once each, castle
   early, and connect your rooks before launching anything. One developed
   army beats three queen sorties.
3. **Check every capture and check.** Before each move, scan the forcing
   moves, yours *and* your opponent's. Most games below master level are
   decided by a piece left hanging, not by strategy.

## A classic pattern or trap

The oldest trap in the book is **Scholar's Mate**. A four-move checkmate
aimed at f7, the one square defended only by the king:

1. e4 e5 2. Qh5 Nc6 3. Bc4, White threatens Qxf7#. If Black plays the
natural 3... Nf6??, then 4. Qxf7# ends the game.

```position
r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4
```

The defense is just as instructive: after 3. Bc4, play **3... g6!** hitting
the queen, and after 4. Qf3 (renewing the threat) **4... Nf6** covers f7
forever. White's early queen now becomes a target, and Black develops with
gain of time. The punishment for breaking principle 2. Learn both sides of
this pattern: you will stop losing to it, and you will understand *why*
"don't bring your queen out early" is a rule and not a superstition.
