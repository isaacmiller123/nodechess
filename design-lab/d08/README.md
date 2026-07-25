# d08

NOTE: written after the fact by the lead, from this direction's actual output. Its
own agent ran out of context after producing all six other files and never wrote
this. Everything below describes what the code does, not what it intended.

FEEL: Sheet Set with Keyed Details
Intuitiveness: learnable. Navigation is a drawing-set index where every screen has
a sheet number (A-101 Home, A-201 Games, A-301 School, A-401 Puzzles, A-501
Account). The plain label sits next to the number, so nothing is hidden, but the
numbering is a convention you learn once and then navigate by faster than by
reading.
Navigation: a persistent sheet index in the left block, current sheet marked with
aria-current and its number picked out in accent. Sections within a page read as
keyed details on the same sheet rather than as separate panels.
Motion: a pen plotter accelerates once and stops. 90 to 340ms, cubic-bezier(0.35,
0, 0.15, 1), no overshoot anywhere.
Mobile: the sheet index becomes sheet tabs across the bottom, each carrying its
number above its title, plus a scale bar. The plan view stays square.

STYLE: Diazo Negative Draft
Palette: #12232c ground (diazo film), #0a1519 drafting table beneath the sheet,
#1c333e poche as the one sanctioned fill, #b9cbc9 the drawn line and nearly white
on purpose, #eae6d9 warm chalk lettering, #5fc4dd printed cyan. Red #de6650 is the
markup pen and appears only where something is being corrected, which is why
danger is the most saturated hue in the system.
Type: Archivo Narrow display, Archivo body, Share Tech Mono for data. All three
OFL, named as exact woff2 files to self-host, with fallbacks that are genuinely
present on macOS and Windows so the drafted character survives instead of
collapsing to system-ui the way the current app silently does. Tracking-normal is
deliberately positive so any feel setting plain labels gets title-block spacing.
Icons: no icon set. Every mark is drawn from the same primitives as the rest of the
sheet: ticks, slashes, hatch, bubbles. Importing an icon family would have brought
a second drawing hand onto the sheet.
Signature: hierarchy carried entirely by line weight, four codified steps (1px
dimension, 2px object, 3px cut, 5px reserved for the one cut per screen). Shadows
are outlines rather than blurs, because a drawing has no light source.

Combines well with: 03 and 05. Both are disciplined and monochrome-leaning, so the
weight ladder stays legible under them. 10 is interesting, since annotation and
redlining are the same instinct.
Fights with: 04 and 06. Saturated arcade colour and material depth both fight a
system whose loudest element is meant to be a thick line, not a bright one. Under
those styles the drawing reads as decorated rather than drafted.

Contract note: this direction's feel.css floors its weight ladder deliberately, so
a swapped style may take away its colour and type but cannot take away the lines,
which would leave a drawing of nothing. That is the most careful swap handling of
the ten.
