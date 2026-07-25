// Public API of the A2 witness fabric (spec §1 PIN, §4 witness fabric, §2
// checkpoints). Platform-neutral + deterministic: same inputs → same bytes on
// node and in the browser bundle.
//
// This barrel re-exports the fabric-core module set. The lease builder
// (lease.ts) and PIN committee (pin.ts) land later in A2 and will be added to
// this barrel by their builder; nothing here forward-references them, so the
// tree typechecks stand-alone.

export * from './types'
export * from './params'
export * from './distance'
export * from './presence'
export * from './eligibility'
export * from './attest'
export * from './cache'
export * from './wtime'
export * from './shamir'
export * from './oprf'
export * from './pin'
export * from './counters'
export * from './chainauth'
export * from './lease'
export * from './slash'
export * from './fabric'
export * from './protocol'
