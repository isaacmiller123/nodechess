import { UserRound } from 'lucide-react'

export function UserAvatar({ src, name, size = 30 }: { src: string | null; name: string; size?: number }) {
  if (src) {
    return <img className="avatar" src={src} width={size} height={size} alt={name} />
  }
  return (
    <span className="avatar avatar-default" style={{ width: size, height: size }} role="img" aria-label={name}>
      <UserRound size={Math.round(size * 0.58)} aria-hidden />
    </span>
  )
}

// Generic opponent avatar (a chess piece): placeholder until per-persona art.
export function EngineAvatar({ label = 'Opponent', size = 30 }: { label?: string; size?: number }) {
  return (
    <span
      className="avatar avatar-engine"
      style={{ width: size, height: size, fontSize: size * 0.62 }}
      role="img"
      aria-label={label}
    >
      <span aria-hidden>♞</span>
    </span>
  )
}
