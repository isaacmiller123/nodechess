// Canonical main-process entry for bot-strength truth. The pure model lives in
// src/shared/botStrength.ts (the renderer needs the same numbers for level and
// persona subtitles, and shared/ is the only module space both sides build).
// Main-process consumers: the vs-bot Glicko updater (ipc/games.ipc.ts), the
// v8 rating-history recompute (ratings/recompute.ts) and School placement.
// Import from HERE so the dependency is explicit and greppable.
export {
  MEASURED_WEAK_ANCHORS,
  botEloLabel,
  isApproxElo,
  measuredElo,
  type RatedBotConfig
} from '../../shared/botStrength'
