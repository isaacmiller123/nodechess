# d04

FEEL: Fixed Control Panel
Intuitiveness: immediate, further out than lichess. Every destination is a
labelled hardware button that is on screen at all times and never moves, so
there is nothing to learn and nothing to find.
Navigation: a lit sign on top carries identity and the rating readout, a fixed
six-button panel on the bottom edge carries every destination, on desktop and
phone alike. No dropdown, no hover-reveal, no overflow menu. The cost is
honest: six holes is the ceiling, so a seventh place lives inside a screen.
Motion: 70ms, no fades, buttons physically travel down on press. Exactly one
thing animates on its own, the START lamp, and reduced motion kills it.
Mobile: the same panel, same six caps, same order, at 46px tall with the
legends screenprinted underneath. The livery switcher moves off the sign and
onto its own strip below it rather than being crushed into it.

STYLE: Cabinet Livery
Palette: #15171E graphite housing, #1D212B bezel plate, #FFB020 amber marquee
light and primary action, #F3F5FA screenprint white, #0B0D12 the panel deck and
every keycap side wall. Four complete liveries: marquee (amber), cobalt,
crimson, lagoon. Each also defines its own six button-cap colours.
Type: display Archivo Black, body Archivo, mono JetBrains Mono. A heavy wide
gothic set uppercase and tight is the vernacular of arcade signage, and mono
carries the readouts and screenprinted legends where digit widths matter.
Fonts are not loaded: the stacks fall back to Arial Black and the system UI
face, and the woff2 files I would self-host are named atop style.css.
Icons: Lucide, ISC licensed, inlined, drawn at stroke-width 2.5 so they hold up
at keycap size. Its flat geometric 24px grid reads as a pictogram screenprinted
onto plastic rather than as a UI glyph.
Signature: the key with real travel. Every action sits on a solid offset shadow
that is a keycap side wall, not a blur, and on press it moves down by exactly
that offset while the wall collapses to nothing.

Combines well with: d01 and d07. Both are dark and token-complete, so their
palettes recolour the panel and the caps without touching a single position.
Any style with a strong accent and real semantic colours gets six distinct
caps for free through my fallbacks.
Fights with: any style built on hairlines, very large radii, or a light type
scale. A 1px border and a 999px radius make a keycap look like a pill, and the
travel shadow stops reading as a physical edge.
