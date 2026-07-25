// Public API of the A3 storage layer (spec §5; contracts: ./types.ts).
// Platform-neutral + deterministic: same inputs → same bytes on node and in
// the browser bundle. The overlay moves bytes and routes; the verifiers here
// gate acceptance (§0: storage confers no authority it did not verify).

export * from './types'
export * from './params'
export * from './rs'
export * from './shards'
export * from './pointers'
export * from './viewer'
