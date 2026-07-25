// nodechess mark: one node linked to its peers. Geometric and symmetric so it
// survives 16px in a dock or taskbar, and monoline in currentColor so it takes
// the rail accent from whichever board theme is active. Keep in sync with the
// copy inlined in scripts/make-icon.cjs, which renders the shipped app icon.
export function Logo({ size = 28, title = 'nodechess' }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      {/* Links first: the filled dots below cover the ends, so no gaps to tune. */}
      <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <line x1="24" y1="24" x2="24" y2="8" />
        <line x1="24" y1="24" x2="10.1" y2="32" />
        <line x1="24" y1="24" x2="37.9" y2="32" />
      </g>
      <g fill="currentColor">
        <circle cx="24" cy="24" r="6" />
        <circle cx="24" cy="8" r="3.6" />
        <circle cx="10.1" cy="32" r="3.6" />
        <circle cx="37.9" cy="32" r="3.6" />
      </g>
    </svg>
  )
}

export default Logo
