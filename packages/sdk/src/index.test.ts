import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as sdk from './index.ts'
import { SDK_VERSION } from './transport.ts'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('SDK_VERSION matches the published version', () => {
  // It is sent on every request as the user agent, so a stale constant misattributes every call in
  // the platform's logs to a version that is not the one running. It cannot be read from
  // package.json at type-check time, so it is kept in step here instead.
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  assert.equal(SDK_VERSION, manifest.version)
})

test('the version is 0.x, which is the honest range for an unreleased API', () => {
  // Semver discipline: 1.0.0 promises stability the platform has not yet earned — devplatform does
  // not exist and the gateway mapping is not defined. The README says which parts are stable.
  assert.match(SDK_VERSION, /^0\./)
})

/**
 * The public surface, enumerated.
 *
 * Backwards compatibility is this package's product. `contract-compat.yml` catches a removed or
 * narrowed TYPE; this catches a removed or renamed VALUE, which the type-surface checker does not
 * see for a runtime export whose type is inferred. Adding a name here is additive and free.
 * Removing one is a breaking change and must be a deliberate edit to this list, not a surprise.
 */
const PUBLIC_VALUES: readonly string[] = [
  'ASSETS',
  'ASSET_CODES',
  'ApiError',
  'AuthError',
  'CloudsForge',
  'CloudsForgeError',
  'ON_CHAIN_ASSETS',
  'PER_ATTEMPT_FIELDS',
  'RATE_SCALE',
  'RATE_SCALE_DECIMALS',
  'ROUTES',
  'ROUTE_NAMES',
  'SDK_VERSION',
  'SHARDS_PER_USD',
  'TimeoutError',
  'Transport',
  'TransportError',
  'UsageError',
  'amountToWire',
  'anonymous',
  'apiKey',
  'assertValidKey',
  'assetSpec',
  'bearerToken',
  'clientCredentials',
  'decimalsFor',
  'deriveKey',
  'fillPath',
  'formatAmount',
  'isAssetCode',
  'isConfirmed',
  'newKey',
  'parseAmount',
  'parseErrorBody',
  'requestFingerprint',
  'toAmount',
  'toAmountOrNull',
  'toSignedAmount',
]

test('the public value surface is exactly what this list records', () => {
  assert.deepEqual(Object.keys(sdk).sort(), [...PUBLIC_VALUES].sort())
})

test('the entry point is importable and constructs a working client', () => {
  const cf = new sdk.CloudsForge({ baseUrl: 'https://api.example.test', credential: sdk.apiKey('k') })
  assert.ok(cf.pricing)
  assert.ok(cf.market)
})
