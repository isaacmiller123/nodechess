// Leaving Play from inside Play.
//
// WHY THIS EXISTS: the shell owns navigation and hands it to a screen as a
// prop, and Play is not given one. "While you wait" is a real section of
// design-lab/v1/play.html whose two rows go to Puzzles and to School, so the
// choice was between not drawing the section and finding the door ourselves.
// The rail is that door: it is mounted on every screen, its buttons are titled
// with the destination's own name, and pressing one runs exactly the handler a
// player pressing it would run. DESTINATIONS is the shell's own list, so the
// name looked up here is the name rendered there and the two cannot drift.
//
// If the shell ever hands Play a navigate callback, prefer it: every caller
// here takes one and only falls back to this.

import { DESTINATIONS, type ViewKey } from '../../components/Layout'

/** Press the rail's own button for `view`. A no-op if the rail is not on the
 *  page, which never happens inside the shell that renders Play. */
export function leavePlay(view: ViewKey): void {
  const label = DESTINATIONS.find((d) => d.key === view)?.label
  if (label === undefined) return
  const link = document.querySelector<HTMLButtonElement>(
    `.rail .rail-link[title="${CSS.escape(label)}"]`
  )
  link?.click()
}
