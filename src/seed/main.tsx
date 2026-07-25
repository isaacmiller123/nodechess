// nodechess seed: entry. Mounts SeedApp; nothing else runs on this page.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SeedApp from './SeedApp'

const host = document.getElementById('root')
if (!host) throw new Error('seed: #root missing')
createRoot(host).render(
  <StrictMode>
    <SeedApp />
  </StrictMode>,
)
