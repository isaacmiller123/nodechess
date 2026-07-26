/**
 * CHANGELOG.md, parsed for the desktop welcome back popup.
 *
 * The file is inlined at build time (Vite `?raw`) because there is no channel
 * that serves it: the renderer cannot read the repo root at runtime on either
 * target. import.meta.glob rather than a direct import so a checkout without
 * the file is an empty list instead of a build error.
 *
 * THE PARSER IS DELIBERATELY BORING AND TOTAL. It never throws and it never
 * guesses: a line it does not recognise is prose, and prose is skipped. The
 * consequence that matters is that a malformed CHANGELOG.md degrades to "no
 * releases yet", which is a true statement about what this build can show,
 * instead of taking the popup (and with it the whole shell) down with it.
 *
 * The format it accepts, documented in CHANGELOG.md itself:
 *
 *     ## 0.9.0 - 2026-08-01
 *     - one line per change
 *
 * A `##` heading only counts as a release when its first word starts with a
 * digit (an optional leading `v` is allowed). That single rule is what lets the
 * file carry prose headings of its own without inventing a release called
 * "Format".
 */

// The wildcard is load bearing twice over: import.meta.glob wants a pattern,
// and a checkout with no CHANGELOG.md then yields {} instead of failing the
// build. It cannot match anything but CHANGELOG.md at the repo root.
const FILES = import.meta.glob('../../../../../CHANGELOG*.md', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

/** One release: a version, an optional date exactly as written, and its lines. */
export interface ChangelogEntry {
  version: string
  /** Whatever followed the `-` on the heading. null when the heading had none. */
  date: string | null
  items: string[]
}

/** `## 0.9.0 - 2026-08-01`. Group 1 version, group 2 the rest of the line. */
const RELEASE_HEADING = /^##\s+(v?\d[^\s]*)\s*(?:-\s*(.*))?$/
/** `- did a thing` or `* did a thing`, at the start of a line. */
const BULLET = /^[-*]\s+(.+)$/

/** Belt and braces: the popup renders these, so cap what a bad file can cost. */
const MAX_ENTRIES = 20
const MAX_ITEMS = 12

/**
 * Parse changelog source. Never throws; unparseable input yields [].
 * Exported separately from the file read so it can be exercised directly.
 */
export function parseChangelog(source: string): ChangelogEntry[] {
  try {
    if (typeof source !== 'string' || source.length === 0) return []
    const entries: ChangelogEntry[] = []
    let current: ChangelogEntry | null = null

    for (const rawLine of source.split(/\r?\n/)) {
      // Indentation makes a line part of the surrounding prose (the format
      // example in CHANGELOG.md is an indented block and must not parse).
      if (rawLine.startsWith('    ') || rawLine.startsWith('\t')) continue
      const line = rawLine.trim()
      if (line === '') continue

      const heading = RELEASE_HEADING.exec(line)
      if (heading) {
        if (entries.length >= MAX_ENTRIES) break
        const date = (heading[2] ?? '').trim()
        current = { version: heading[1], date: date === '' ? null : date, items: [] }
        entries.push(current)
        continue
      }

      // Any other heading closes the release it follows, so stray bullets
      // further down the file cannot be attributed to it.
      if (line.startsWith('#')) {
        current = null
        continue
      }

      if (!current) continue
      const bullet = BULLET.exec(line)
      if (bullet && current.items.length < MAX_ITEMS) current.items.push(bullet[1].trim())
    }

    // A heading with nothing under it is not a release note, it is a typo.
    return entries.filter((e) => e.items.length > 0)
  } catch {
    return []
  }
}

/** The parsed contents of the repo's CHANGELOG.md, newest first as written. */
export function loadChangelog(): ChangelogEntry[] {
  const source = Object.values(FILES)[0]
  return typeof source === 'string' ? parseChangelog(source) : []
}
