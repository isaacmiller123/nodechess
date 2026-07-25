// Public API of the A3 Kademlia overlay (spec §5; contract: ./types.ts).
// Platform-neutral + deterministic: same inputs → same route on node and in
// the browser bundle. The fabric (witness/fabric.ts or a real transport) is
// transport + bootstrap ONLY; every routing decision lives in this module set.

export * from './types'
export * from './kbucket'
export * from './rpc'
export * from './node'
