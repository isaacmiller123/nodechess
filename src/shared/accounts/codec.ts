// cjson-v1: the canonical serialization every signature and hash in the
// accounts system commits to (FROZEN-AT-GENESIS, docs/ACCOUNTS-PARAMS.md).
//
// Rules:
//  - values: object | array | string | integer | boolean. Nothing else.
//  - integers only: safe range, no -0, no floats. Fractional quantities are
//    fixed-point integers upstream (e.g. rating micro-units).
//  - no null and no undefined: absent means absent. The serializer THROWS on
//    null/undefined/float/bigint/function/symbol: it never normalizes.
//  - object keys sorted by UTF-8 byte order; duplicate keys impossible by
//    construction, rejected on parse.
//  - strings must already be NFC; the serializer throws otherwise.
//  - string escaping: exactly ", \, and control chars < 0x20; control chars
//    use \b \t \n \f \r where defined, else \u00XX lowercase hex. No other
//    escaping (no \/, no \uXXXX for printable chars): one byte stream per
//    value on every engine.
//  - output is UTF-8 bytes with no insignificant whitespace.
//
// Bytes (keys, sigs, hashes) are represented as base64url-no-pad strings by
// schema convention (hash.ts toB64u): the codec itself only sees strings.

import { sha256, utf8 } from './hash'

export type CanonicalValue = string | number | boolean | CanonicalArray | CanonicalObject
export type CanonicalArray = readonly CanonicalValue[]
// `undefined` members are permitted by the TYPE (optional fields) and skipped
// by the serializer: absent means absent. `undefined` inside arrays throws.
export type CanonicalObject = { readonly [key: string]: CanonicalValue | undefined }

export class CodecError extends Error {
  constructor(message: string, readonly path: string) {
    super(`cjson-v1: ${message} at ${path || '$'}`)
    this.name = 'CodecError'
  }
}

const ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
}

function escapeString(s: string, path: string): string {
  if (s.normalize('NFC') !== s) throw new CodecError('string is not NFC-normalized', path)
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate must be followed by a low surrogate, else TextEncoder
      // would silently substitute U+FFFD and break byte determinism
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new CodecError('lone surrogate in string', path)
      out += ch + s[i + 1]
      i++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new CodecError('lone surrogate in string', path)
    if (ESCAPES[ch] !== undefined) out += ESCAPES[ch]
    else if (code < 0x20) out += '\\u00' + code.toString(16).padStart(2, '0')
    else out += ch
  }
  return out + '"'
}

// UTF-8 byte order for JS strings: compare by code point (surrogate-aware),
// which matches UTF-8 byte comparison exactly.
export function compareKeys(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  const n = la < lb ? la : lb
  for (let i = 0; i < n; i++) {
    let ca = a.codePointAt(i) as number
    let cb = b.codePointAt(i) as number
    if (ca !== cb) return ca < cb ? -1 : 1
    if (ca > 0xffff) i++ // consumed a surrogate pair in both (equal here)
  }
  return la === lb ? 0 : la < lb ? -1 : 1
}

function writeValue(v: unknown, path: string): string {
  switch (typeof v) {
    case 'string':
      return escapeString(v, path)
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number': {
      if (!Number.isSafeInteger(v)) throw new CodecError(`not a safe integer: ${v}`, path)
      if (Object.is(v, -0)) throw new CodecError('negative zero', path)
      return String(v)
    }
    case 'object': {
      if (v === null) throw new CodecError('null is not representable (omit the field)', path)
      if (Array.isArray(v)) {
        const parts: string[] = []
        for (let i = 0; i < v.length; i++) parts.push(writeValue(v[i], `${path}[${i}]`))
        return '[' + parts.join(',') + ']'
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null)
        throw new CodecError('only plain objects are representable', path)
      const keys = Object.keys(v as object)
      for (const k of keys) {
        if (k.normalize('NFC') !== k) throw new CodecError('object key is not NFC', `${path}.${k}`)
        // '__proto__' survives canonical round-trip but is silently DROPPED by
        // assignment-based copies (zod record parsing): the byte layer and the
        // schema layer would disagree about what a body is. Never representable.
        if (k === '__proto__') throw new CodecError("'__proto__' is not a representable key", path)
      }
      keys.sort(compareKeys)
      const parts: string[] = []
      for (const k of keys) {
        const member = (v as Record<string, unknown>)[k]
        if (member === undefined) continue // absent means absent
        parts.push(escapeString(k, path) + ':' + writeValue(member, `${path}.${k}`))
      }
      return '{' + parts.join(',') + '}'
    }
    default:
      throw new CodecError(`unrepresentable type: ${typeof v}`, path)
  }
}

/** Serialize to the one canonical UTF-8 byte stream. Throws CodecError on any non-canonical input. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return utf8(writeValue(value, ''))
}

/** sha256 over the canonical bytes: the hash every id/signature in the system uses. */
export function canonicalHash(value: CanonicalValue): Uint8Array {
  return sha256(canonicalBytes(value))
}

/**
 * Strict parse of canonical bytes: parses as JSON, then re-serializes and
 * compares byte-for-byte, so any non-canonical encoding (float forms, key
 * order, whitespace, escaping variants, duplicate keys, nulls) is rejected.
 */
export function parseCanonical(bytes: Uint8Array): CanonicalValue {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CodecError('invalid UTF-8', '')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CodecError('invalid JSON', '')
  }
  const reserialized = writeValue(parsed, '')
  if (reserialized !== text) throw new CodecError('input is not in canonical form', '')
  return parsed as CanonicalValue
}
