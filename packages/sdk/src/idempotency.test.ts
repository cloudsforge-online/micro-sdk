import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageError } from './errors.ts'
import {
  PER_ATTEMPT_FIELDS,
  assertValidKey,
  deriveKey,
  newKey,
  requestFingerprint,
} from './idempotency.ts'

test('a retry with a fresh correlation id derives the SAME key, not a second operation', () => {
  // The client half of ledger/src/idempotency.test.ts:5. A correlation id is a trace identifier
  // and is SUPPOSED to change per attempt. If it fed the derived key, attempt two would carry a
  // different key — and a different key on POST /v1/withdrawals is a second withdrawal.
  const first = { assetCode: 'BTC', amount: '100000', correlationId: 'req-aaa' }
  const retry = { assetCode: 'BTC', amount: '100000', correlationId: 'req-bbb' }
  assert.equal(deriveKey('withdrawals.request', first), deriveKey('withdrawals.request', retry))
})

test('a changed amount derives a DIFFERENT key, so it is not silently replayed', () => {
  const first = { assetCode: 'BTC', amount: '100000' }
  const other = { assetCode: 'BTC', amount: '900000' }
  assert.notEqual(deriveKey('withdrawals.request', first), deriveKey('withdrawals.request', other))
})

test('the same body on two routes derives two keys', () => {
  // The service namespaces stored keys by route (ledger/src/idempotency.ts:106). A client that did
  // not would be relying on that to avoid a collision it created itself.
  const body = { amount: '10' }
  assert.notEqual(deriveKey('money.spend', body), deriveKey('money.transfer', body))
})

test('field order does not change the fingerprint', () => {
  // JSON.stringify preserves insertion order, so an unsorted fingerprint would reject a legitimate
  // retry whose fields happened to serialise differently — a false 409 that is maddening to
  // diagnose from the caller's side. Same reasoning as ledger/src/idempotency.ts:88.
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
})

test('a bigint and its decimal string fingerprint identically', () => {
  // A body fingerprinted before serialisation and one fingerprinted after must agree, or the SDK
  // and the service would disagree about whether two attempts were the same operation.
  assert.equal(requestFingerprint({ amount: 100n }), requestFingerprint({ amount: '100' }))
})

test('an undefined field is absent, not null', () => {
  assert.equal(requestFingerprint({ a: 1 }), requestFingerprint({ a: 1, b: undefined }))
  assert.notEqual(requestFingerprint({ a: 1 }), requestFingerprint({ a: 1, b: null }))
})

test('every per-attempt field is excluded, and the list matches the ledger’s', () => {
  assert.deepEqual([...PER_ATTEMPT_FIELDS].sort(), ['correlationId', 'idempotencyKey'])
  for (const field of PER_ATTEMPT_FIELDS) {
    assert.equal(
      requestFingerprint({ amount: '1' }),
      requestFingerprint({ amount: '1', [field]: 'anything' }),
      `${field} leaked into the fingerprint`,
    )
  }
})

test('a derived key is inside the bound the market service enforces', () => {
  // market/src/server.ts:1138 answers 400 outside 8..200 characters.
  const key = deriveKey('market.buy', { amount: '1' })
  assert.doesNotThrow(() => assertValidKey(key))
  assert.doesNotThrow(() => assertValidKey(newKey()))
})

test('a caller’s own key is validated locally rather than by a round trip', () => {
  assert.throws(() => assertValidKey('short'), UsageError)
  assert.throws(() => assertValidKey('x'.repeat(201)), UsageError)
  assert.throws(() => assertValidKey('has spaces here'), UsageError)
  assert.doesNotThrow(() => assertValidKey('order-2026-07-31:00042'))
})

test('newKey is not stable — it is for two distinct operations with identical bodies', () => {
  assert.notEqual(newKey(), newKey())
})

test('a nested per-attempt field is NOT stripped, because only the top level is a request field', () => {
  // Deliberate: stripping at every depth would silently erase a domain field that happened to be
  // called correlationId, and the service only strips the top level too.
  assert.notEqual(
    requestFingerprint({ meta: { correlationId: 'a' } }),
    requestFingerprint({ meta: { correlationId: 'b' } }),
  )
})
