# d01

FEEL: Flat nav, persistent readout
Intuitiveness: immediate. Every destination is a plain word in one row, and there is no dropdown, no hover reveal, no drawer and no modal anywhere in these four screens; the cost is density, which this style can carry.
Navigation: one horizontal header of six words plus an identity chip, with a fixed-slot readout strip pinned directly beneath it on every screen, so the eye learns a single location for "where am I and what is true".
Motion: 90 to 140ms colour and border changes, nothing eases in and out; the only animated geometry in the whole design is the readout trace filling.
Mobile: the word row becomes a five-word bottom bar with 60px targets, the readout wraps to two lines and keeps its trace, and Play becomes the primary control on Home rather than a tab.

STYLE: Graphite instrument, amber signal
Palette: #1a1c1e graphite page; #131517 recessed wells, darker than the page so containers read as milled rather than floating; #212426 raised panels; #e4e7e9 near-white text, because an instrument is read at a glance; #cfa257 brass, spent only on the current thing and the one primary action; #dd7f3c warning, pushed toward orange so it cannot be mistaken for the accent.
Type: Inter for everything readable, JetBrains Mono for every label, identifier and number, and --font-display is the sans on purpose because a third voice would be costume. The scale ceiling is 23px: this style has no display sizes, and hierarchy is carried by weight, rule work and colour instead. Fonts are not installed on this machine, so the stacks name the exact files to ship (InterVariable.woff2 and JetBrainsMono[wght].woff2, both SIL OFL, self-hosted, no CDN) and fall through to the platform UI face and SF Mono, which is what these pages are actually rendering.
Icons: Radix Icons (MIT), a 15x15 grid at one optical weight, chosen because it was drawn to sit inline with UI text rather than to illustrate. Nine glyphs appear in total; words do everything else. The inlined SVGs are drawn to that grid, so swap in the real files on adoption.
Signature: the readout strip. A monospace state line in the same slots on every screen, with a one pixel trace along its bottom edge that is the only quantitative graphic in the design: a 2px tick at zero games played, 40% at lesson 3 of 5, full width when all 22 games are listed.

Combines well with: d03 and d09, both dark and restrained with a signal-amber logic close to mine, so my dense table and readout recolour cleanly and my compressed scale suits their grotesques. Also d04, d05 and d06, because this feel hard-codes no colour, family or radius, so their palette switching drives it without a single edit.
Fights with: d07. Verified by swapping its style.css over my school page: the layout held exactly, but its condensed display face and large display sizes have nothing to do here, because this feel never reaches above 23px. Its most characteristic asset goes unused, so the pairing wastes what makes d07 good.
