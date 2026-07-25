# d07

FEEL: Score bug and ticker frame
Intuitiveness: immediate. Five channels sit on screen on every screen, nothing
expands on hover or hides in a drawer, so moving around is changing channels.
Navigation: a fixed top bug (wordmark, live count, identity, channel strip) and a
fixed bottom ticker permanently frame a stage that is the only thing that swaps.
Motion: one broadcast open on load (bar drops, panels rise in sequence, pressure
bars swing, telestrator draws), then the ticker is the only thing still moving,
and it pauses on hover and stops under reduced motion.
Mobile: the bug stays, the ticker moves under it as one line, the channel strip
becomes a five-target tab bar at the thumb, and the desktop ON NOW column becomes
a snap carousel of the same cards.

STYLE: Studio indigo and gold
Palette: #101425 studio backdrop, #05060d recessed ink for the bug and ticker
rails, #191e36 lifted panels, #ffc531 broadcast gold for every primary action and
the on-air bar, #ff2e43 signal red spent only on LIVE, #45c8ff cyan for
information and focus.
Type: display Barlow Condensed (would ship self-hosted woff2, SIL OFL; falls back
to Arial Narrow, present on mac and Windows, so the condensed character survives
today), body system-ui, mono the OS mono stack. Condensed caps are the jersey and
score-bug voice; body and mono name only faces the OS has, so nothing is promised
that is not shipped.
Icons: Lucide (ISC, free commercially), 24px box, 2px stroke, round caps, drawn
inline to those conventions so the real set drops in unchanged. Its square
terminals match the 2px radii of overlay hardware.
Signature: the frame. A bug pinned to the top, a live ticker pinned to the bottom,
the app playing between them. Boards are telestrator boards, squares mixed from
the palette's own text and background tokens, so a swapped style repaints them.
Risk taken: permanent auto-scrolling chrome. A ticker is normally bad UI, so it
earns its place by carrying the only time-varying content, sitting outside the
reading column, pausing on hover, stopping under reduced motion, and making every
line a real destination.

Combines well with: 02 and 03, whose quieter palettes cool the frame without
touching it, and any style with one strong accent, since the frame spends accent
in three places. Verified against 02: structure identical, look completely theirs.
Fights with: large radii or heavy shadows, which soften a score bug into a card,
and any style whose accent is red, since LIVE stops being the only red thing.
