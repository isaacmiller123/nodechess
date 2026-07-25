# d05

FEEL: Docked command line
Intuitiveness: learnable. There is no header nav and no sidebar on any screen,
so nothing is discoverable by scanning. What keeps it from being hostile is the
key legend docked above the command line: it is always on screen and it changes
per screen, the way nano and htop have always done it. Home is the one screen
that teaches, listing 6 of the 13 commands with their keys, and the other
screens assume you learned them there.
Navigation: a bottom dock on every screen, palette above key legend above
prompt. Slash or ctrl-k opens the palette, typing filters it, a prefix match
beats a match mid-word, enter runs the selection. Single letters jump directly
except on games, where letters go to the board filter instead.
Motion: quantised, not eased. The token easing is steps(3, end) and the only
thing that actually moves is the block cursor.
Mobile: the dock has no keyboard to sit on, so the roster becomes the interface
as 62px rows that still show the desktop key, and the command line becomes a
56px bar that opens the palette as a sheet.

STYLE: Monochrome terminal
Palette: four monochrome sets, dark only, switchable in the title bar.
  ink #0b0c0d page / #e9ecee text, the cold neutral house set
  warm #100e0c page / #f0eae2 text, grey with a toner cast
  cold #090c10 page / #e5eaf0 text, a tube with the colour gun removed
  hard #000000 page / #ffffff text, maximum contrast
  #d5453b danger, the single hue in the entire system, errors only. success,
  warning and info are greys on purpose so no decoration can borrow a colour.
Type: one family in all three roles. Ship IBM Plex Mono (SIL OFL) self hosted
as woff2; the files are not in the repo yet so no @font-face is declared and
the stack resolves to the platform mono, which is the faithful stand-in. The
pairing is the point: no second face, so hierarchy comes from 400/500/600,
seven sizes and 0.16em tracking on uppercase labels.
Icons: pixel grid icons in the Pixelarticons idiom (MIT), inlined, drawn as
square rects on a 24 grid. Rounded 2px stroke sets fight a character cell.
Signature: the dock, and inverse video as the only selection state anywhere.

Combines well with: 02 and 07, both tested by swapping their style.css over
these pages. Neither moved anything, because this feel never assumes a hue.
Fights with: any style leaning on large radii and blurred shadows. Every join
here is a 1px rule or a hard offset block, so soft edges will read as a mistake.
