// nodechess seed — the whole UI.
//
// One button, a handful of numbers, and nothing else. This page is run by
// people donating capacity to the network, not administered; every control that
// isn't start/stop is a control they'd have to understand to use, so there are
// almost none. The numbers shown are all things the swarm actually measured —
// no projections, no scores, no gamification.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { MAX_NODES, SeedSwarm, DEFAULT_CONFIG, EMPTY_STATS, type SeedConfig } from './swarm'
import './seed.css'

const swarm = new SeedSwarm()

/** Bytes → a short human string. Deliberately coarse: this is a status line, not
 *  an accounting report. */
function formatBytes(n: number): string {
  if (n <= 0) return '0 MB'
  const mb = n / (1024 * 1024)
  if (mb < 1) return '<1 MB'
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function formatUptime(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export default function SeedApp(): JSX.Element {
  const [config, setConfig] = useState<SeedConfig>(DEFAULT_CONFIG)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState(EMPTY_STATS)

  // The swarm pushes on lifecycle changes; the 1s tick keeps uptime and peer
  // counts moving between them.
  useEffect(() => {
    const sync = (): void => {
      setRunning(swarm.running)
      setStats(swarm.stats())
    }
    const unsub = swarm.subscribe(sync)
    const tick = setInterval(sync, 1000)
    return () => {
      unsub()
      clearInterval(tick)
    }
  }, [])

  // A closed tab should leave the network cleanly rather than waiting for our
  // presence records to go stale in everyone's directory.
  useEffect(() => {
    const bye = (): void => void swarm.stop()
    window.addEventListener('pagehide', bye)
    return () => window.removeEventListener('pagehide', bye)
  }, [])

  const toggle = useCallback(async () => {
    setBusy(true)
    try {
      if (swarm.running) await swarm.stop()
      else await swarm.start(config)
    } finally {
      setBusy(false)
    }
  }, [config])

  return (
    <main className="seed">
      <header className="seed-head">
        <span className="seed-wordmark">nodechess</span>
        <span className="seed-sub">seed node</span>
      </header>

      <p className="seed-lead">
        Runs nodechess nodes on this machine. They store and relay data for other players and help
        people find each other. Leave the tab open — that&rsquo;s the whole job.
      </p>

      <button
        type="button"
        className={`seed-power${running ? ' on' : ''}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={running}
      >
        <span className="seed-power-dot" aria-hidden />
        {busy ? (running ? 'Stopping…' : 'Starting…') : running ? 'Stop' : 'Start'}
      </button>

      <dl className="seed-stats">
        <div className="seed-stat">
          <dt>Nodes</dt>
          <dd>
            {stats.nodesConnected}
            <span className="seed-of">/{stats.nodesRunning || config.nodes}</span>
          </dd>
          <span className="seed-note">connected</span>
        </div>
        <div className="seed-stat">
          <dt>Peers</dt>
          <dd>{stats.peersReachable}</dd>
          <span className="seed-note">others reached</span>
        </div>
        <div className="seed-stat">
          <dt>Storing</dt>
          <dd>{formatBytes(stats.storedBytes)}</dd>
          <span className="seed-note">of {stats.capacityMb || config.nodes * config.shardMb} MB offered</span>
        </div>
        <div className="seed-stat">
          <dt>Uptime</dt>
          <dd>{formatUptime(stats.uptimeMs)}</dd>
          <span className="seed-note">this session</span>
        </div>
      </dl>

      <details className="seed-settings">
        <summary>Settings</summary>

        <label className="seed-field">
          <span className="seed-field-label">
            Nodes to run
            <em>More nodes carry more of the network. Each one uses a little memory.</em>
          </span>
          <input
            type="range"
            min={1}
            max={MAX_NODES}
            value={config.nodes}
            disabled={running || busy}
            onChange={(e) => setConfig((c) => ({ ...c, nodes: Number(e.target.value) }))}
          />
          <output className="seed-field-value">{config.nodes}</output>
        </label>

        <label className="seed-field">
          <span className="seed-field-label">
            Storage per node
            <em>Disk offered to hold other players&rsquo; data.</em>
          </span>
          <input
            type="range"
            min={10}
            max={200}
            step={10}
            value={config.shardMb}
            disabled={running || busy}
            onChange={(e) => setConfig((c) => ({ ...c, shardMb: Number(e.target.value) }))}
          />
          <output className="seed-field-value">{config.shardMb} MB</output>
        </label>

        <label className="seed-check">
          <input
            type="checkbox"
            checked={config.mode === 'witness'}
            disabled={running || busy}
            onChange={(e) => setConfig((c) => ({ ...c, mode: e.target.checked ? 'witness' : 'infrastructure' }))}
          />
          <span className="seed-field-label">
            Act as a witness
            <em>
              Witnesses sign off on ranked games between other players. Only turn this on if you were
              asked to — a witness is trusted, and the network needs them to be independent.
            </em>
          </span>
        </label>
      </details>

      <footer className="seed-foot">
        Storing and relaying is anonymous and carries no authority — this node can&rsquo;t read
        anyone&rsquo;s data or vouch for anything.
      </footer>
    </main>
  )
}
