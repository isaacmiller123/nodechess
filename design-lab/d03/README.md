# d03

FEEL: Fixed header, numbered rows
Intuitiveness: immediate. Every destination, field name and count is on screen at
all times, and nothing expands, drops down or is revealed by hovering, so there
is no state to learn before you can act.
Navigation: three fixed header bands (identity, destinations, context) over one
record row used on all four screens, with a stable catalogue number on every
game, so 14 is always International draughts.
Motion: colour and background changes only, 80 to 130ms, no slide, no scale, no
reveal; reduced motion removes even those.
Mobile: the destinations band leaves the top and becomes a five slot bottom tab
bar, records grow from 28px to 56px with the clock set large and the length
underneath, and the column label row stays, since losing it loses the one thing
that makes a dense row readable.

STYLE: Night slate, signal amber
Palette: #0E1217 ground and #171E26 surface, blue slate and never neutral black;
#F2B01E signal amber for the current thing and the primary action, taken from the
yellow departure poster; #E4E9EF text over #6B7784 field labels; #E04B42 held
back so red only ever means stop; six route colours (#F2B01E #7C9CF5 #E0637A
#4FB477 #3FBFC0 #B48CE0), one per game family, all read with a fallback.
Type: display Arial Narrow, body Helvetica Neue, mono SF Mono. No @font-face:
stack-safe by choice and verified resolving on the target, with Roboto Condensed
and Helvetica Now Text as the woff2 files to ship later. Narrow faces exist to
fit a column, which is the whole job here.
Icons: Material Symbols Sharp, weight 400 (Apache 2.0): a 24px box, 2px strokes,
squared terminals, the same construction as transit pictograms. The inlined SVGs
are hand drawn to that box; swap in the real files on adoption.
Signature: the 28px lattice. Label rows are the same height as record rows, so
rules line up across the column rules and the whole page reads as one ruled
sheet. Columns close on a foot rule rather than trailing off: the move strip on
one side, the 40 chapter scale on the other.

Combines well with: 05 and 01. Both keep a tight type scale and a small space
step, which is what a 28px row wants, and 05's monochrome leaves the ruled
structure carrying all the meaning.
Fights with: 10 and 09. Their larger base size and roomier space steps push
uppercase field labels to the edge of their columns, and 10's slab serif in a
posted timetable row reads bookish rather than announced.
