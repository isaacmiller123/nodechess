import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// chessground board + cburnett pieces (embedded, fully offline)
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'

import './styles/tokens.css'
import './styles/global.css'
import './styles/app.css'
import './styles/pieces.css'

// games-art URL wiring (side effect: sets window.__gamesArtBase for the 3D
// tabletop's artLoader; 2D boards import gamesArtUrl from it directly).
import './games/art'

function mount(): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}

// Preview-only test harness: when opened in a plain browser with `?mock` and no
// real preload bridge, install a fake window.api so the UI is fully driveable.
// The packaged desktop app always has window.api, so this never runs there.
const params =
  typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
const wantMock = params !== null && !window.api && params.has('mock')

// Dev harness for the shared 3D tabletop (games/three/**): `?three=<kind>`
// mounts the demo INSTEAD of the app (code-split, the three.js bundle never
// loads otherwise). See features/games/Three3DDemo.tsx.
const threeDemoKind = params?.get('three') ?? null

// Dev harness for Replay Theater: `?theater=<kind>` mounts the cinematic
// replay over a canned finished game. See features/library/TheaterDemo.tsx.
const theaterDemoKind = params?.get('theater') ?? null

if (threeDemoKind !== null) {
  import('./features/games/Three3DDemo').then((m) => {
    const Demo = m.default
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <Demo kindParam={threeDemoKind} />
        </ErrorBoundary>
      </React.StrictMode>
    )
  })
} else if (theaterDemoKind !== null) {
  import('./features/library/TheaterDemo').then((m) => {
    const Demo = m.default
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <Demo kindParam={theaterDemoKind} />
        </ErrorBoundary>
      </React.StrictMode>
    )
  })
} else if (wantMock) {
  import('./devMock')
    .then((m) => m.installMock())
    .catch(() => undefined)
    .finally(mount)
} else {
  mount()
}

// Packaged-app CSP/WASM self-test (`?smoke-wasm=1`, set by main for the
// --smoke-wasm launch: see smokeWasm.ts). Runs IN ADDITION to the normal
// mount above; code-split so the probe never loads in a real session.
if (params?.has('smoke-wasm')) {
  import('./smokeWasm').then((m) => m.runSmokeWasm())
}
