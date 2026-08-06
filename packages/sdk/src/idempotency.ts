/**
 * Idempotency keys, and the fingerprint that decides whether two attempts are the same operation.
 *
 * ## The defect this file exists to not repeat
 *
 * `ledger/src/idempotency.test.ts` — "a retry with a fresh correlation id is a replay, not a
 * 409". Its comment names where it came from: a correlation id is a trace identifier and is
 * *supposed* to change on every attempt, because that is what makes a retry distinguishable in a
 * trace. Include it in the fingerprint and a caller doing exactly the right thing is told its
 * idempotency key was reused with a different payload. `micro-wallet` had to carry a correlation
 * id that was stable per operation rather than per attempt to work around it.
 *
 * The service fixed that on its side (`PER_ATTEMPT_FIELDS` at `ledger/src/idempotency.ts`).
 * This file is the client half, and it has to make the same exclusion for a different reason:
 * `autoKey` derives a key from the request body, so a body field that changes per attempt would
 * derive a DIFFERENT key on the retry — and a different key is not a retry at all, it is a second
 * operation. On a `POST /v1/withdrawals` that is a second withdrawal.
 *
 * ## Why the key is derived and not random by default
 *
 * A random key regenerated per call makes the retry-safety it was meant to provide vanish: attempt
 * two carries a new key, the service sees a new operation, and the user is debited twice. A key
 * derived from the request content is stable across attempts by construction. A caller who wants
 * two genuinely distinct operations with identical bodies passes their own key — and `newKey()` is
 * there for it.
 */

import { createHash, randomUUID } from 'node:crypto'
import { UsageError } from './errors.ts'

/**
 * Fields that legitimately differ between attempts at the *same* operation.
 *
 * Mirrors `ledger/src/idempotency.ts`. `correlationId` is the sharp one and the reason the set
 * exists; `idempotencyKey` is here because a body that already carries the key must not have the
 * key feed back into deriving it.
 */
export const PER_ATTEMPT_FIELDS: readonly string[] = Object.freeze([
  'correlationId',
  'idempotencyKey',
])

/**
 * `market/src/server.ts` refuses anything outside 8..200 characters with a 400. Matching the
 * bound here turns a round trip into a local throw with a message that says what to do.
 */
const MIN_KEY_LENGTH = 8
const MAX_KEY_LENGTH = 200
const SAFE_KEY = /^[A-Za-z0-9._:@/-]{8,200}$/

export function assertValidKey(key: string): void {
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    throw new UsageError(
      `an idempotency key must be ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters (got ${key.length})`,
    )
  }
  if (!SAFE_KEY.test(key)) {
    throw new UsageError('an idempotency key must be URL-safe: letters, digits and ._:@/-')
  }
}

/** A fresh random key. For two genuinely distinct operations with identical bodies. */
export function newKey(): string {
  return `cf-${randomUUID()}`
}

/**
 * A key derived from the operation, stable across every attempt at it.
 *
 * `route` is in the digest so the same body sent to two routes cannot collide, which matters
 * because the service namespaces stored keys by route as well (`ledger/src/idempotency.ts`)
 * and a client that did not would be relying on that.
 */
export function deriveKey(route: string, body: unknown): string {
  return `cf-${createHash('sha256').update(`${route}\n${canonicalise(strip(body))}`).digest('hex').slice(0, 32)}`
}

/**
 * The canonical fingerprint of a request body.
 *
 * Exported because it is the thing a caller most often needs to reason about when a 409 arrives:
 * two fingerprints that differ explain the 409, and two that agree mean the collision is real.
 *
 * Keys are sorted at every depth. `JSON.stringify` preserves insertion order, so two semantically
 * identical bodies that serialised their fields in a different order would fingerprint differently
 * and a legitimate retry would be rejected as reuse — a class of false 409 that is maddening to
 * diagnose from the caller's side. Same reasoning, same implementation as
 * `ledger/src/idempotency.ts`.
 */
export function requestFingerprint(body: unknown): string {
  return createHash('sha256').update(canonicalise(strip(body))).digest('hex')
}

function strip(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) => !PER_ATTEMPT_FIELDS.includes(key),
    ),
  )
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  // A bigint canonicalises as its decimal string — the same form it takes on the wire — so a body
  // fingerprinted before serialisation and one fingerprinted after agree.
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}
