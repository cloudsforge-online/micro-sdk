import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROUTE_NAMES } from '@cloudsforge/sdk'
import { EXIT } from './exit.ts'
import { jsonReplacer, table } from './render.ts'
import { CLI_VERSION, credentialFrom, run, type Io } from './run.ts'
import { parse } from './args.ts'

interface Harness {
  readonly io: Io
  readonly stdout: string[]
  readonly stderr: string[]
  readonly requests: { method: string; path: string; auth: string | undefined }[]
}

function harness(
  answer: (path: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} }),
  env: Record<string, string> = { CLOUDSFORGE_BASE_URL: 'https://api.example.test' },
): Harness {
  const stdout: string[] = []
  const stderr: string[] = []
  const requests: { method: string; path: string; auth: string | undefined }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const parsed = new URL(String(url))
    const headers = (init.headers ?? {}) as Record<string, string>
    requests.push({
      method: String(init.method),
      path: parsed.pathname,
      auth: headers['authorization'],
    })
    const { status, body } = answer(parsed.pathname)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  return {
    io: { out: (t) => stdout.push(t), err: (t) => stderr.push(t), env, fetch },
    stdout,
    stderr,
    requests,
  }
}

/* ------------------------------------------------------------------ shape of the tool */

test('no arguments prints help and exits 2, so a bare invocation is not a success', async () => {
  const h = harness()
  assert.equal(await run([], h.io), EXIT.USAGE)
  assert.match(h.stdout.join('\n'), /USAGE/)
})

test('--help exits 0; --version prints the version', async () => {
  const h = harness()
  assert.equal(await run(['--help'], h.io), EXIT.OK)
  assert.equal(await run(['--version'], h.io), EXIT.OK)
  assert.ok(h.stdout.includes(CLI_VERSION))
})

test('routes needs no base URL and no network', async () => {
  const h = harness(undefined, {})
  assert.equal(await run(['routes'], h.io), EXIT.OK)
  assert.equal(h.requests.length, 0)
  const printed = h.stdout.join('\n')
  for (const name of ROUTE_NAMES) assert.ok(printed.includes(name), `${name} missing from routes`)
})

test('routes --json lists every route with its citation', async () => {
  const h = harness(undefined, {})
  await run(['routes', '--json'], h.io)
  const rows = JSON.parse(h.stdout.join('')) as { name: string; verifiedAt: string }[]
  assert.equal(rows.length, ROUTE_NAMES.length)
  for (const row of rows) assert.match(row.verifiedAt, /\/src\/server\.ts:\d+$/)
})

test('no base URL is a usage error that names the variable, and makes no request', async () => {
  const h = harness(undefined, {})
  assert.equal(await run(['rates'], h.io), EXIT.USAGE)
  assert.match(h.stderr.join('\n'), /CLOUDSFORGE_BASE_URL/)
  assert.equal(h.requests.length, 0)
})

test('an unknown command exits 2 and points at --help', async () => {
  const h = harness()
  assert.equal(await run(['teleport'], h.io), EXIT.USAGE)
  assert.match(h.stderr.join('\n'), /unknown command: teleport/)
})

/* ------------------------------------------------------------------ public vs authenticated */

test('a public command works with no credential at all', async () => {
  const h = harness(() => ({ status: 200, body: { listings: [] } }))
  assert.equal(await run(['listings'], h.io), EXIT.OK)
  assert.equal(h.requests[0]?.auth, undefined)
  assert.equal(h.stdout.join('\n'), '(none)')
})

test('an API key from the environment reaches an authenticated route and not a public one', async () => {
  const h = harness(
    (path) =>
      path === '/v1/portfolio'
        ? { status: 200, body: { subject: 'user:1', balances: [], wallets: [], degraded: [], asOf: 'now', nextCursor: null } }
        : { status: 200, body: { listings: [] } },
    { CLOUDSFORGE_BASE_URL: 'https://api.example.test', CLOUDSFORGE_API_KEY: 'k' },
  )
  await run(['portfolio'], h.io)
  await run(['listings'], h.io)
  assert.equal(h.requests[0]?.auth, 'Bearer k')
  assert.equal(h.requests[1]?.auth, undefined)
})

test('the credential precedence is stated and honoured', () => {
  const env = {
    CLOUDSFORGE_API_KEY: 'key',
    CLOUDSFORGE_TOKEN: 'tok',
    CLOUDSFORGE_TOKEN_URL: 'https://auth.example.test/t',
    CLOUDSFORGE_CLIENT_ID: 'id',
    CLOUDSFORGE_CLIENT_SECRET: 'secret',
  }
  const io: Io = { out: () => {}, err: () => {}, env }
  assert.equal(credentialFrom(parse(['x']), io).kind, 'client-credentials')
  assert.equal(
    credentialFrom(parse(['x']), { ...io, env: { CLOUDSFORGE_TOKEN: 't', CLOUDSFORGE_API_KEY: 'k' } }).kind,
    'bearer',
  )
  assert.equal(credentialFrom(parse(['x']), { ...io, env: { CLOUDSFORGE_API_KEY: 'k' } }).kind, 'api-key')
  assert.equal(credentialFrom(parse(['x']), { ...io, env: {} }).kind, 'anonymous')
})

/* ------------------------------------------------------------------ exit codes */

test('401 and 403 exit 3, and the message says which way to look', async () => {
  for (const status of [401, 403]) {
    const h = harness(() => ({
      status,
      body: { error: { code: 'unauthorised', message: 'no', requestId: 'r-1' } },
    }))
    assert.equal(await run(['portfolio'], h.io), EXIT.AUTH)
    assert.match(h.stderr.join('\n'), /request id: r-1/)
  }
})

test('404 exits 4, another 4xx exits 5, a 5xx exits 6', async () => {
  const cases: readonly (readonly [number, number])[] = [
    [404, EXIT.NOT_FOUND],
    [409, EXIT.REFUSED],
    [422, EXIT.REFUSED],
    [500, EXIT.UNAVAILABLE],
    [503, EXIT.UNAVAILABLE],
  ]
  for (const [status, expected] of cases) {
    const h = harness(() => ({ status, body: { error: { code: 'x', message: 'y' } } }))
    assert.equal(await run(['listing', 'l-1'], h.io), expected, `status ${status}`)
  }
})

test('a missing positional is a usage error before any request', async () => {
  const h = harness()
  assert.equal(await run(['listing'], h.io), EXIT.USAGE)
  assert.equal(h.requests.length, 0)
  assert.match(h.stderr.join('\n'), /usage: cloudsforge listing <id>/)
})

test('an unknown asset is refused locally rather than by a round trip', async () => {
  const h = harness()
  assert.equal(await run(['rates', '--asset', 'DOGE'], h.io), EXIT.USAGE)
  assert.equal(h.requests.length, 0)
})

test('--role is validated against the two the service accepts', async () => {
  const h = harness()
  assert.equal(await run(['orders', '--role', 'auditor'], h.io), EXIT.USAGE)
  assert.equal(h.requests.length, 0)
})

/* ------------------------------------------------------------------ --json */

test('--json survives a bigint, as a decimal string and never as a number', async () => {
  // JSON.stringify throws on a bigint, and the SDK decodes every money field into one — so without
  // the replacer, almost every --json command would fail. And Number() here is where an 18-decimal
  // amount would stop being the amount.
  const h = harness(
    () => ({
      status: 200,
      body: {
        subject: 'user:1',
        asOf: '2026-07-31T00:00:00Z',
        degraded: [],
        nextCursor: null,
        wallets: [],
        balances: [{ assetCode: 'EMBER', purpose: 'available', amount: '12345678901234567890', valuation: null }],
      },
    }),
    { CLOUDSFORGE_BASE_URL: 'https://api.example.test', CLOUDSFORGE_API_KEY: 'k' },
  )
  assert.equal(await run(['portfolio', '--json'], h.io), EXIT.OK)
  const parsedOut = JSON.parse(h.stdout.join('')) as { balances: { amount: unknown }[] }
  assert.equal(parsedOut.balances[0]?.amount, '12345678901234567890')
  assert.equal(typeof parsedOut.balances[0]?.amount, 'string')
})

test('the replacer converts only bigints', () => {
  assert.equal(jsonReplacer('a', 1n), '1')
  assert.equal(jsonReplacer('a', 'x'), 'x')
  assert.equal(jsonReplacer('a', null), null)
  assert.equal(jsonReplacer('a', 5), 5)
})

test('the table and the JSON render the same decoded fields', async () => {
  const body = {
    listings: [
      { id: 'l1', assetKind: 'token', itemUrn: 'cf:mint:token:1', quantity: '1', price: '500', assetCode: 'SHARD', status: 'active' },
    ],
  }
  const plain = harness(() => ({ status: 200, body }))
  const asJson = harness(() => ({ status: 200, body }))
  await run(['listings'], plain.io)
  await run(['listings', '--json'], asJson.io)
  const rows = JSON.parse(asJson.stdout.join('')) as { id: string; price: string }[]
  assert.equal(rows[0]?.price, '500')
  assert.match(plain.stdout.join('\n'), /l1/)
  assert.match(plain.stdout.join('\n'), /500/)
})

/* ------------------------------------------------------------------ output that must not lie */

test('portfolio always prints degraded, even when nothing is degraded', async () => {
  // "We could not reach the indexer" and "there is nothing on chain" must never look the same.
  const h = harness(
    () => ({
      status: 200,
      body: { subject: 'user:1', balances: [], wallets: [], degraded: [], asOf: 'now', nextCursor: null },
    }),
    { CLOUDSFORGE_BASE_URL: 'https://api.example.test', CLOUDSFORGE_API_KEY: 'k' },
  )
  await run(['portfolio'], h.io)
  assert.match(h.stdout.join('\n'), /degraded\s+\(nothing\)/)
})

test('an unusable rate is listed with its reason rather than omitted', async () => {
  const h = harness(() => ({
    status: 200,
    body: {
      spreadBps: 50,
      rates: [
        {
          asset: 'EMBER',
          usable: false,
          reason: 'no administered price set',
          usd: null,
          quotedAt: null,
          usdScaled: null,
          usdSellScaled: null,
          usdBuyScaled: null,
          shardsPerCoinSellScaled: null,
          shardsPerCoinBuyScaled: null,
          rateScale: '1000000',
        },
      ],
    },
  }))
  await run(['rates'], h.io)
  const printed = h.stdout.join('\n')
  assert.match(printed, /EMBER/)
  assert.match(printed, /no administered price set/)
})

test('a market is never printed without its as-of and its staleness', async () => {
  const h = harness(() => ({
    status: 200,
    body: {
      market: { id: 'm1', question: 'Will it?', status: 'open', closeTime: 't', questionHash: '0xabc' },
      pool: { yes: '1', no: '2', total: '3', stakerCount: 2, asOf: null, stale: true },
      document: { canonical: 'x', hash: '0xabc' },
      provenance: null,
    },
  }))
  await run(['market', 'm1'], h.io)
  const printed = h.stdout.join('\n')
  assert.match(printed, /as of\s+-/)
  assert.match(printed, /stale\s+true/)
})

test('an empty result set says so rather than printing nothing at all', () => {
  assert.equal(table([], [{ heading: 'id', of: () => '' }]), '(none)')
})

test('the catalogue renders the body the deployed mint returns, in the unit mint quotes', async () => {
  // The end of micro-org#227 §1, exercised through the command a person actually types.
  //
  // The body below is the `GET /v1/catalogue` handler's own object in `mint/src/server.ts`, plus
  // the `VARIANTS` table in `mint/src/catalogue.ts` that `variantFor` reads. It carries no
  // `priceShards`: mint removed that field when SHARD was retired on 2026-08-04 and
  // `mint/src/server.test.ts` asserts it is `undefined` here. Cited by file and route rather than
  // by line — see the note on the same fixture in the SDK's `decode.test.ts`.
  //
  // Against this body `cf mint catalogue` used to exit non-zero: the SDK decoded `priceShards`
  // with the strict `toAmount`, which throws `UsageError` on a missing field. Two things are
  // asserted, because either one alone would have passed while the command was wrong — an exit
  // code (the command runs at all) and the label (the number is named in the unit it is in).
  const h = harness(() => ({
    status: 200,
    body: {
      priceUsdCents: '2500',
      settlementAsset: 'EMBER',
      network: 'mainnet',
      variants: [
        { variant: 'fixed', contract: 'FixedSupplyToken', features: [], cap: 'forbidden' },
        { variant: 'foundry', contract: 'FoundryToken', features: ['mintable', 'burnable', 'pausable'], cap: 'required' },
      ],
    },
  }))
  assert.equal(await run(['catalogue'], h.io), EXIT.OK)
  const printed = h.stdout.join('\n')
  assert.match(printed, /price \(USD cents\)\s+2500/)
  assert.match(printed, /FoundryToken/)
  // No retired asset anywhere on the screen. The old label said "shards" over a cents figure,
  // which is the failure this whole issue is about: a right number under a wrong unit.
  assert.doesNotMatch(printed, /shard/i)
})
