import { useState, type JSX } from 'react'
import { Ban, Download, FileKey, HardDrive, ShieldAlert } from 'lucide-react'
import type { UiDevice } from '../mock/types'
import { shortB64u } from '../mock/fixtures'
import { useAccountsUi } from '../mock/store'
import { RecoveryExport } from '../auth/RecoveryExport'
import './hub.css'

/**
 * Account tab: the devices signed in to this account, and the recovery export.
 *
 * This used to carry a committee meter, a worked example of a tripped fuse, and a
 * taxonomy of every way to be banned, including the exact anticheat threshold
 * that does and does not oblige one. All of it is gone and none of it comes back.
 *
 * PIN provisioning is not offered because it cannot currently succeed. The
 * protocol keeps that path intact (lease.verifyTakeover), so enabling it later is
 * an append rather than a migration, and the account keeps working meanwhile.
 */

function enrolledDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * One device signed in to the account. Removing one needs the network, so the
 * control is honestly disabled when there is none. A disabled button beats a mock
 * that appears to work.
 */
function DeviceRow({ device }: { device: UiDevice }): JSX.Element {
  const revoked = Boolean(device.revoked)

  return (
    <li className={`ahub-device${revoked ? ' is-revoked' : ''}`}>
      <div className="ahub-device-row">
        <span className="ahub-device-icon" aria-hidden>
          <HardDrive size={16} />
        </span>
        <div className="ahub-device-main">
          <span className="ahub-device-label">
            <span className="ahub-device-name">{device.label}</span>
            {device.thisDevice && <span className="ahub-pill is-accent">This device</span>}
            {revoked && (
              <span className="ahub-pill is-danger">
                <Ban size={11} aria-hidden /> Removed
              </span>
            )}
          </span>
          <span className="ahub-device-meta muted small">
            <code>{shortB64u(device.pub)}</code> · added {enrolledDate(device.enrolledTs)}
          </span>
        </div>
        {!device.thisDevice && !revoked && (
          <button
            type="button"
            className="btn danger small ahub-device-revoke"
            disabled
            title="Needs a connection"
          >
            Remove
          </button>
        )}
      </div>
    </li>
  )
}

export function SecurityTab(): JSX.Element {
  const ui = useAccountsUi()
  const [exportOpen, setExportOpen] = useState(false)

  const devices = ui.devices ?? []
  const active = devices.filter((d) => !d.revoked).length

  return (
    <div className="ahub-security">
      <section className="panel" aria-labelledby="ahub-devices-title">
        <div className="panel-head">
          <span className="ahub-head-icon" aria-hidden>
            <HardDrive size={15} />
          </span>
          <span className="panel-title" id="ahub-devices-title">
            Devices
          </span>
          <span className="muted small num">
            {active} signed in
          </span>
        </div>
        <p className="ahub-lede muted small">
          Sign in with your name and password on any device and it appears here.
        </p>
        <ul className="ahub-devices">
          {devices.map((d) => (
            <DeviceRow key={d.pub} device={d} />
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="ahub-recovery-title">
        <div className="panel-head">
          <span className="ahub-head-icon" aria-hidden>
            <FileKey size={15} />
          </span>
          <span className="panel-title" id="ahub-recovery-title">
            Recovery
          </span>
        </div>
        <div className="ahub-panel-body">
          <div className="ahub-recovery-row">
            <span className="setting-label">
              <strong>Save your recovery phrase</strong>
              <span className="setting-sub">
                There is no password reset. If you lose your phrase and your password, the account
                is gone. Keep one copy somewhere safe.
              </span>
            </span>
            <button type="button" className="btn ahub-ibtn" onClick={() => setExportOpen(true)}>
              <Download size={14} aria-hidden /> Save
            </button>
          </div>
          <p className="ahub-panel-foot">
            <ShieldAlert size={14} aria-hidden />
            <span>Anyone who has your password has your account. Don&rsquo;t reuse it.</span>
          </p>
        </div>
      </section>

      {exportOpen && <RecoveryExport onClose={() => setExportOpen(false)} />}
    </div>
  )
}
