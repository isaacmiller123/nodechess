// Which platform is this renderer running on? The web entry
// (src/web/main.web.tsx) sets `window.__chessSharpWeb = true` BEFORE importing
// '@/main', so this constant is decided once at module load. On desktop the
// flag never exists: isWebBuild is false and every branch on it renders the
// exact desktop UI. Also safe in bare node (headless test bundles): no window,
// so it's false there too.
export const isWebBuild =
  typeof window !== 'undefined' && (window as { __chessSharpWeb?: boolean }).__chessSharpWeb === true
