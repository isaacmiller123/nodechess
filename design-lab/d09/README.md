# d09

FEEL: Dimmed stack, lit focus
Intuitiveness: learnable. Nothing is hidden, every destination is on screen at
once, but you have to notice that brightness is what tells you where you are.
Navigation: no header, no sidebar, no menus. Destinations coexist as panels on
one dark stage and only the attended one is lit; a fixed instrument cluster on
the bottom edge holds your name, your rating and the one thing that is live.
Motion: one arrival on load, then light moving between panels on hover, focus
and click. Nothing else animates.
Mobile: the bottom edge belongs to the thumb, so the cluster splits. Identity
rides up top as a sticky strip and the lamps become a four-tab bar, with the
board as the hero and a swipeable rail of clocks under it.

STYLE: Sodium and petrol night
Palette: `#08101d` petrol ground, the far end of the road. `#16203a` surface
and `#232746` lifted surface, the ramp shifts from cold to violet as a panel
comes closer to the light. `#f0a13d` sodium amber, the lamp over whatever you
are using. `#7fd0ff` instrument cyan, focus only, so focus and accent are
never the same light. `#e8ebf5` headlight white for type.
Type: Overpass for display (drawn from US highway signage, the lettering you
actually read at night from a car), IBM Plex Sans for body, IBM Plex Mono for
clocks, ratings and notation. Signage plus instrument panel, one story.
Icons: Lucide (ISC, free commercially), inlined. Stroked marks read as
filaments at low luminance where a filled glyph reads as a hole. A few are
drawn on Lucide's 24px grid where the glyph does not exist; swap in the real
files on adoption.
Fonts: no `@font-face`, because there are no font files in this lab. I would
ship woff2 subsets of Overpass and IBM Plex Sans/Mono. Meanwhile each stack
names the face first and falls back to a resident grotesque, so nothing
silently becomes `system-ui` the way the app does today.
Signature: the pool of light. One warm wash behind exactly one panel, one row,
one square. Look elsewhere and it moves there; on the school board it is f7.

Combines well with: 03 and 08, whose dark blue-slate grounds have a ramp deep
enough for the dimmer to read. Tested against 02: warm graphite and its serif
recolour and retype this feel completely, and nothing rearranged.
Fights with: 05. Swapped in, the layout held exactly, but its accent is
achromatic, so the pool of light survives as value only and the warm against
cool logic that makes this direction itself is gone.
