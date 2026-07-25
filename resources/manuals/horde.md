# Horde

Horde is the most lopsided fair fight in chess: White commands **thirty-six
pawns and nothing else**; Black has a normal army. White wins by checkmate,
Black wins by eating every last pawn. Both sides play a game that looks
like chess and feels like siege warfare.

## The rules

Black's setup, pieces, and rules are completely standard. White's side is
different:

1. **White has 36 pawns and no king.** They fill ranks 1–4 entirely, plus
   four advanced pawns on b5, c5, f5 and g5.

```position
rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1
```

2. **Win conditions.** White wins by **checkmating** the black king. Black
   wins by **capturing every white unit**. All pawns and anything they
   promote into.
3. **Pawn rules.** White pawns move, capture and promote normally. Pawns
   still on White's **first rank may also advance two squares**, just like
   pawns on the second. En passant applies to any double-step. Promotion
   (usually to a queen) is White's path from siege to mate.
4. **White cannot be checked**. There is no white king. Black's king obeys
   all normal rules: it can be checked, mated, and stalemated.
5. **Draws** are as in chess: stalemate (either side having no legal move),
   threefold repetition, agreement. If Black is reduced to a bare king, the
   game is not over. White must still deliver mate.

Moves are written in standard SAN.

## Reading the board

White's side of the board is a wall of pawns; read it in **files and
chains**, not individual units. The material counter is Black's win-progress
bar: it counts white units remaining. When you play White, watch for the
counter's other meaning: every pawn Black wins is also a file Black has
pried open, and open files cut both ways.

## Three principles

1. **(As Black) Eat toward structure, not just material.** Capturing a
   pawn matters less than *which* pawn: take the ones whose removal makes
   the pawns behind them undefended, and blockade on the color squares the
   horde can't attack. A knight parked on a blockading square in front of
   the wall is worth two hungry rooks behind it.
2. **(As White) Advance in phalanxes, promote by force.** Lone pawn rushes
   feed the enemy pieces. Push two and three abreast so every advanced pawn
   is defended twice, aim the mass at one wing, and count sacrifices: three
   pawns for a cleared path to promotion is a bargain. A queen mates,
   pawns only march.
3. **Mind the endgame arithmetic.** For Black, trades of pieces for pawns
   must be audited: pieces are your only tools, and running out of force
   with a dozen pawns left loses. For White, stalemate is a real resource.
   A sealed position where Black's pieces can't get in is a draw, not a
   loss.

## A classic pattern or trap

The pattern every horde player must know from both sides is the **pawn
breakthrough**: White's standard method of turning three blocked pawns
into a queen. The kernel of it:

```position
6k1/ppp5/8/PPP5/8/8/8/8 w - - 0 1
```

Three white pawns face three black pawns, everything blocked, and White
wins by force: **1. b6! axb6** (1... cxb6 2. a6! bxa6 3. c6 and the c-pawn
runs) **2. c6! bxc6 3. a6** and nothing on the board can catch the a-pawn:
3... Kf7 4. a7 Ke6 5. a8=Q, and the new queen begins the mating attack.

White gives up two pawns to guarantee one promotion. In horde that trade
is the whole strategy in miniature. As White, steer every wing you attack
toward a structure like this; the threat of the break is often enough to
force Black's pieces into passive blockade duty. As Black, the defense is
to **never allow the trio to line up**: capture one of the advancing pawns
*before* the structure locks, or post a piece (not a pawn) on the
breakthrough square so the sacrifices win nothing. Count the breakthrough
squares on every wing, every move. The horde only needs one.
