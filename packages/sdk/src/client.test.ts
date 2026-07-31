import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudsForge } from './client.ts'
import { apiKey } from './credentials.ts'
import { ApiError, UsageError } from './errors.ts'

interface Seen {
  readonly method: string
  readonly path: string
  readonly search: string
  readonly body: unknown
  readonly headers: Record<string, string>
}

function client(answer: (seen: Seen) => Response | Promise<Response>): {
  cf: CloudsForge
  calls: Seen[]
} {
  const calls: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const parsed = new URL(String(url))
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value
    }
    const seen: Seen = {
      method: String(init.method),
      path: parsed.pathname,
      search: parsed.search,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers,
    }
    calls.push(seen)
    return answer(seen)
  }) as unknown as typeof globalThis.fetch

  return {
    cf: new CloudsForge({
      baseUrl: 'https://api.example.test',
      credential: apiKey('k'),
      fetch,
      retries: 0,
    }),
    calls,
  }
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/* ------------------------------------------------------------------ money on the wire */

test('a bigint amount crosses the wire as a decimal string, never as a JSON number', () => {
  const { cf, calls } = client(() => ok({ entryId: 'e1', replayed: false, summary: {} }))
  return cf.money
    .spend({ amount: 12_345_678_901_234_567_890n, reason: 'test' })
    .then(() => {
      const body = calls[0]?.body as Record<string, unknown>
      assert.equal(body['amount'], '12345678901234567890')
      assert.equal(typeof body['amount'], 'string')
    })
})

test('a zero or negative amount is refused before any request is made', async () => {
  const { cf, calls } = client(() => ok({}))
  await assert.rejects(() => cf.money.spend({ amount: 0n, reason: 'x' }), UsageError)
  await assert.rejects(() => cf.money.transfer({ toUserId: 'u', assetCode: 'SHARD', amount: -1n }), UsageError)
  await assert.rejects(
    () => cf.withdrawals.request({ assetCode: 'BTC', destination: 'bc1', amount: 0n }),
    UsageError,
  )
  await assert.rejects(() => cf.market.buy('l1', 0n), UsageError)
  assert.equal(calls.length, 0, 'a request that cannot succeed must cost nothing')
})

test('a token supply of 10^24 is sent as a string', async () => {
  const { cf, calls } = client(() => ok({ token: { supply: '1', cap: null, priceShards: '0' } }))
  await cf.mint.createToken({
    chain: 'ember',
    name: 'Test',
    symbol: 'TST',
    decimals: 18,
    supply: 10n ** 24n,
    cap: 2n * 10n ** 24n,
    ownerAddress: '0x1',
    ownerWalletId: 'w1',
  })
  const body = calls[0]?.body as Record<string, unknown>
  assert.equal(body['supply'], '1000000000000000000000000')
  assert.equal(body['cap'], '2000000000000000000000000')
})

/* ------------------------------------------------------------------ decoding on the way back */

test('a portfolio comes back with bigint balances', async () => {
  const { cf } = client(() =>
    ok({
      subject: 'user:1',
      balances: [{ assetCode: 'SHARD', amount: '100', valuation: null }],
      wallets: [],
      degraded: [],
      nextCursor: null,
    }),
  )
  const portfolio = await cf.portfolio.get()
  assert.equal(portfolio.balances[0]?.amount, 100n)
})

test('the rate board keeps unusable assets, with their reason', async () => {
  const { cf } = client(() =>
    ok({
      spreadBps: 50,
      rates: [
        {
          asset: 'EMBER',
          usable: false,
          reason: 'no administered price set',
          usdScaled: null,
          usdSellScaled: null,
          usdBuyScaled: null,
          shardsPerCoinSellScaled: null,
          shardsPerCoinBuyScaled: null,
          rateScale: '1000000',
        },
      ],
    }),
  )
  const board = await cf.pricing.rates()
  // Omitting an unusable asset is how a deposit page loses a coin — pricing/src/server.ts:307.
  assert.equal(board.rates.length, 1)
  assert.equal(board.rates[0]?.usable, false)
  assert.equal(board.rates[0]?.reason, 'no administered price set')
})

/* ------------------------------------------------------------------ requests and queries */

test('a query is sent as query parameters, not folded into the path', async () => {
  const { cf, calls } = client(() => ok({ wallets: [], nextCursor: null }))
  await cf.wallets.list({ limit: 25, includeRetired: true })
  assert.equal(calls[0]?.path, '/v1/wallets')
  const search = new URLSearchParams(calls[0]?.search)
  assert.equal(search.get('limit'), '25')
  assert.equal(search.get('includeRetired'), 'true')
})

test('revoking "all" disconnects the wallet through the path, not a body flag', async () => {
  const { cf, calls } = client(() => ok({ link: null }))
  await cf.wallets.revokeAuthorisation('w-1', 'all')
  assert.equal(calls[0]?.method, 'DELETE')
  assert.equal(calls[0]?.path, '/v1/wallets/w-1/authorisations/all')
})

test('a rotate is an explicit ask and is absent otherwise', async () => {
  const { cf, calls } = client(() => ok({ assignment: {} }))
  await cf.deposits.assign('BTC')
  assert.deepEqual(calls[0]?.body, { assetCode: 'BTC' })
  await cf.deposits.assign('BTC', { rotate: true })
  assert.deepEqual(calls[1]?.body, { assetCode: 'BTC', rotate: true })
})

test('clearing a cosmetic slot sends an explicit null, not an omitted field', async () => {
  // Omitting it would leave the slot as it was. `null` is the clear.
  const { cf, calls } = client(() => ok({ profile: {} }))
  await cf.worlds.equip({ slot: 'hat', itemUrn: null })
  assert.deepEqual(calls[0]?.body, { slot: 'hat', itemUrn: null })
})

/* ------------------------------------------------------------------ idempotency in practice */

test('two identical spends collapse to one key; two different ones do not', async () => {
  const { cf, calls } = client(() => ok({ entryId: 'e', replayed: false, summary: {} }))
  await cf.money.spend({ amount: 100n, reason: 'coffee' })
  await cf.money.spend({ amount: 100n, reason: 'coffee' })
  await cf.money.spend({ amount: 200n, reason: 'coffee' })
  assert.equal(calls[0]?.headers['idempotency-key'], calls[1]?.headers['idempotency-key'])
  assert.notEqual(calls[0]?.headers['idempotency-key'], calls[2]?.headers['idempotency-key'])
})

test('two genuinely separate transfers of the same amount need distinct keys, and can have them', async () => {
  // The derived key would collapse them. This is the case `idempotencyKey` exists for, and the
  // SDK documents it rather than guessing on the caller's behalf.
  const { cf, calls } = client(() => ok({ entryId: 'e', replayed: false, summary: {} }))
  const request = { toUserId: 'u2', assetCode: 'SHARD' as const, amount: 500n }
  await cf.money.transfer(request, { idempotencyKey: 'payout-2026-07-31-a' })
  await cf.money.transfer(request, { idempotencyKey: 'payout-2026-07-31-b' })
  assert.notEqual(calls[0]?.headers['idempotency-key'], calls[1]?.headers['idempotency-key'])
})

test('a mutating market call carries a key even though the SDK derives it', async () => {
  const { cf, calls } = client(() => ok({ order: { quantity: '1', amount: '1', feeAmount: '0', royaltyAmount: '0', sellerProceeds: '1', royalties: [] }, replayed: false }))
  await cf.market.buy('l-1', 500n)
  assert.ok(calls[0]?.headers['idempotency-key'])
})

/* ------------------------------------------------------------------ errors */

test('a service error reaches the caller with its code and its request id', async () => {
  const { cf } = client(() =>
    new Response(
      JSON.stringify({
        error: { code: 'insufficient_funds', message: 'not enough Shards', requestId: 'req-77' },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ),
  )
  const err = await cf.money
    .spend({ amount: 100n, reason: 'x' })
    .then(() => undefined, (e: unknown) => e)
  assert.ok(err instanceof ApiError)
  assert.equal(err.code, 'insufficient_funds')
  assert.equal(err.requestId, 'req-77')
  assert.equal(err.peerDecided, true)
  assert.equal(err.isIdempotencyConflict, false)
})

test('a reused key with a changed body surfaces as isIdempotencyConflict', async () => {
  const { cf } = client(() =>
    new Response(
      JSON.stringify({ error: { code: 'idempotency_key_reuse', message: 'reused', requestId: 'r1' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ),
  )
  const err = await cf.market
    .buy('l-1', 100n, { idempotencyKey: 'order-000001' })
    .then(() => undefined, (e: unknown) => e)
  assert.ok(err instanceof ApiError)
  assert.equal(err.isIdempotencyConflict, true)
})

/* ------------------------------------------------------------------ the public/private split */

test('a public read works with no credential at all', async () => {
  const calls: string[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push(String((init.headers as Record<string, string>)['authorization']))
    void url
    return ok({ listings: [] })
  }) as unknown as typeof globalThis.fetch
  const cf = new CloudsForge({ baseUrl: 'https://api.example.test', fetch })
  assert.deepEqual([...(await cf.market.listings())], [])
  assert.deepEqual(calls, ['undefined'])
})

test('the resource groups are exactly the twelve the surface documents', () => {
  const cf = new CloudsForge({ baseUrl: 'https://api.example.test' })
  const groups = Object.keys(cf).sort()
  assert.deepEqual(groups, [
    'activity',
    'deposits',
    'foresight',
    'identity',
    'market',
    'mint',
    'money',
    'portfolio',
    'pricing',
    'wallets',
    'withdrawals',
    'worlds',
  ])
})
