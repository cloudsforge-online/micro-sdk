import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudsForge } from './client.ts'
import { apiKey } from './credentials.ts'
import { ROUTES, ROUTE_NAMES, fillPath, type RouteName } from './routes.ts'

/* ------------------------------------------------------------------ the table itself */

test('every route cites the file and line it was verified against', () => {
  // The citations are how the next person re-checks the claim. A malformed one is a citation
  // nobody can follow, which is the same as not having one.
  for (const name of ROUTE_NAMES) {
    const route = ROUTES[name]
    assert.match(
      route.verifiedAt,
      /^[a-z-]+\/src\/server\.ts:\d+$/,
      `${name}: verifiedAt must be '<service>/src/server.ts:<line>' (got ${route.verifiedAt})`,
    )
    // The citation must name the service the route says it belongs to, or one of them is wrong.
    assert.equal(
      route.verifiedAt.split('/')[0],
      route.service,
      `${name}: the citation names a different service from the route`,
    )
  }
})

test('no two routes are the same method and path', () => {
  const seen = new Map<string, RouteName>()
  for (const name of ROUTE_NAMES) {
    const key = `${ROUTES[name].method} ${ROUTES[name].path}`
    const existing = seen.get(key)
    assert.equal(existing, undefined, `${name} duplicates ${String(existing)} (${key})`)
    seen.set(key, name)
  }
})

test('no route reaches an operator, admin or internal surface', () => {
  // The rule this repository exists to hold. `/admin/*` is identity's and pricing's operator
  // surface; `/internal/*` is refused at the gateway outright
  // (deploy/gateway/dynamic/policy.yml); `/events` and `/ingest` are HMAC-signed intakes for the
  // event relay and are not a third party's to post to.
  const forbidden = [/^\/admin\b/, /^\/internal\b/, /\/moderation\b/, /^\/events$/, /^\/ingest$/, /^\/v1\/events$/]
  for (const name of ROUTE_NAMES) {
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(ROUTES[name].path),
        false,
        `${name} (${ROUTES[name].path}) is an internal or operator surface`,
      )
    }
  }
})

test('no route touches the ledger', () => {
  // Every ledger route requires a SERVICE token — `authorise` refuses a user principal outright at
  // ledger/src/server.ts. A third party can never reach one, so offering a method for it would
  // ship a guaranteed 403. The README says so under "what the API does not offer".
  for (const name of ROUTE_NAMES) {
    assert.notEqual((ROUTES[name] as { service: string }).service, 'ledger')
  }
})

test('a mutating route is never marked auth: none', () => {
  for (const name of ROUTE_NAMES) {
    const route = ROUTES[name]
    if (route.method === 'GET') continue
    assert.notEqual(route.auth, 'none', `${name} mutates and must carry a credential`)
  }
})

test('every route that requires an idempotency key is a POST', () => {
  for (const name of ROUTE_NAMES) {
    if (ROUTES[name].idempotency !== 'required') continue
    assert.equal(ROUTES[name].method, 'POST', `${name} requires a key but is not a POST`)
  }
})

test('the routes the services refuse without an Idempotency-Key are all marked required', () => {
  // Read off the handlers: `requireIdempotencyKey(...)` in wallet, `withIdempotentRoute(...)` in
  // market. Missing one here means the SDK sends no key and the caller gets a 400 they cannot act
  // on — or worse, on a route that tolerates a missing key, a duplicate operation.
  const mustRequire: readonly RouteName[] = [
    'withdrawals.request',
    'money.spend',
    'money.transfer',
    'money.convert',
    'market.createListing',
    'market.buy',
    'market.placeBid',
    'market.makeOffer',
    'market.acceptOffer',
  ]
  for (const name of mustRequire) {
    assert.equal(ROUTES[name].idempotency, 'required', `${name} must be marked idempotency: required`)
  }
})

test('fillPath encodes each parameter and refuses a missing one', () => {
  assert.equal(fillPath('/v1/wallets/:id', { id: 'w-1' }), '/v1/wallets/w-1')
  assert.equal(
    fillPath('/v1/verifications/:urn', { urn: 'cf:market:item:1' }),
    '/v1/verifications/cf%3Amarket%3Aitem%3A1',
  )
  assert.equal(
    fillPath('/v1/wallets/:id/authorisations/:authorisation', { id: 'w', authorisation: 'all' }),
    '/v1/wallets/w/authorisations/all',
  )
  assert.throws(() => fillPath('/v1/wallets/:id', {}), TypeError)
  assert.throws(() => fillPath('/v1/wallets/:id', { id: '' }), TypeError)
  // A traversal attempt is encoded, not resolved.
  assert.equal(fillPath('/v1/wallets/:id', { id: '../admin' }), '/v1/wallets/..%2Fadmin')
})

/* ------------------------------------------------------------------ the client walks the table */

/**
 * Every route name, exercised through the public client.
 *
 * This is the test that stops the SDK growing a method the platform does not serve. It drives each
 * resource method against a recording fetch and asserts:
 *
 *   - every entry in ROUTES is reachable from the client (no dead route),
 *   - every request the client makes names a route that is in ROUTES (no invented route),
 *   - the method and path on the wire are the ones the table declares.
 *
 * The exhaustiveness is enforced by the type: `Record<RouteName, …>` fails to compile the moment a
 * route is added without a driver.
 */
const DRIVERS: Record<RouteName, (cf: CloudsForge) => Promise<unknown>> = {
  'pricing.rates': (cf) => cf.pricing.rates(),
  'pricing.rate': (cf) => cf.pricing.rate('BTC'),

  'wallet.list': (cf) => cf.wallets.list(),
  'wallet.register': (cf) => cf.wallets.register({ chain: 'eth', address: '0x1', origin: 'watch' }),
  'wallet.get': (cf) => cf.wallets.get('w-1'),
  'wallet.update': (cf) => cf.wallets.update('w-1', { label: 'cold' }),
  'wallet.verify': (cf) => cf.wallets.verify({ nonce: 'n', signature: 's' }),
  'wallet.grantAuthorisation': (cf) => cf.wallets.grantAuthorisation('w-1', 'withdraw'),
  'wallet.revokeAuthorisation': (cf) => cf.wallets.revokeAuthorisation('w-1', 'all'),

  'deposits.assign': (cf) => cf.deposits.assign('BTC'),
  'deposits.list': (cf) => cf.deposits.list(),
  'deposits.credits': (cf) => cf.deposits.credits(),

  'withdrawals.request': (cf) =>
    cf.withdrawals.request({ assetCode: 'BTC', destination: 'bc1q', amount: 1000n }),
  'withdrawals.list': (cf) => cf.withdrawals.list(),
  'withdrawals.get': (cf) => cf.withdrawals.get('wd-1'),

  'money.spend': (cf) => cf.money.spend({ amount: 100n, reason: 'test' }),
  'money.transfer': (cf) => cf.money.transfer({ toUserId: 'u2', assetCode: 'SHARD', amount: 100n }),
  'money.convert': (cf) =>
    cf.money.convert({ fromAssetCode: 'BTC', toAssetCode: 'SHARD', amount: 100n }),

  'portfolio.get': (cf) => cf.portfolio.get(),

  'market.collections': (cf) => cf.market.collections(),
  'market.createCollection': (cf) => cf.market.createCollection({ slug: 's', name: 'n' }),
  'market.listings': (cf) => cf.market.listings(),
  'market.listing': (cf) => cf.market.listing('l-1'),
  'market.createListing': (cf) =>
    cf.market.createListing({
      assetKind: 'token',
      itemUrn: 'cf:mint:token:1',
      itemAssetCode: 'EMBER',
      assetCode: 'SHARD',
      pricingMode: 'fixed',
      settlementMode: 'custodial',
      price: 500n,
    }),
  'market.activateListing': (cf) => cf.market.activateListing('l-1'),
  'market.cancelListing': (cf) => cf.market.cancelListing('l-1'),
  'market.risk': (cf) => cf.market.risk('l-1'),
  'market.buy': (cf) => cf.market.buy('l-1', 500n),
  'market.bids': (cf) => cf.market.bids('l-1'),
  'market.placeBid': (cf) => cf.market.placeBid('l-1', 600n),
  'market.offers': (cf) => cf.market.offers('l-1'),
  'market.makeOffer': (cf) => cf.market.makeOffer('l-1', 400n),
  'market.withdrawOffer': (cf) => cf.market.withdrawOffer('o-1'),
  'market.acceptOffer': (cf) => cf.market.acceptOffer('o-1'),
  'market.orders': (cf) => cf.market.orders(),
  'market.order': (cf) => cf.market.order('o-1'),
  'market.openDispute': (cf) => cf.market.openDispute('o-1', 'not delivered'),
  'market.verification': (cf) => cf.market.verification('cf:market:item:1'),

  'mint.catalogue': (cf) => cf.mint.catalogue(),
  'mint.createToken': (cf) =>
    cf.mint.createToken({
      chain: 'ember',
      name: 'Test',
      symbol: 'TST',
      decimals: 18,
      supply: 10n ** 24n,
      ownerAddress: '0x1',
      ownerWalletId: 'w-1',
    }),
  'mint.tokens': (cf) => cf.mint.tokens(),
  'mint.token': (cf) => cf.mint.token('t-1'),
  'mint.pay': (cf) => cf.mint.pay('t-1'),
  'mint.deploy': (cf) => cf.mint.deploy('t-1'),
  'mint.putPage': (cf) => cf.mint.putPage('t-1', { description: 'x' }),
  'mint.page': (cf) => cf.mint.page('t-1'),

  'foresight.categories': (cf) => cf.foresight.categories(),
  'foresight.markets': (cf) => cf.foresight.markets(),
  'foresight.market': (cf) => cf.foresight.market('m-1'),
  'foresight.position': (cf) => cf.foresight.position('m-1', '0xabc'),
  'foresight.stakeIntent': (cf) => cf.foresight.stakeIntent('m-1', { amount: '1', outcome: 0 }),

  'worlds.titles': (cf) => cf.worlds.titles(),
  'worlds.player': (cf) => cf.worlds.player(),
  'worlds.updatePlayer': (cf) => cf.worlds.updatePlayer({ displayName: 'x' }),
  'worlds.equip': (cf) => cf.worlds.equip({ slot: 'hat', itemUrn: null }),
  'worlds.inventory': (cf) => cf.worlds.inventory(),
  'worlds.listItem': (cf) => cf.worlds.listItem('i-1', 'cf:market:listing:1'),
  'worlds.unlistItem': (cf) => cf.worlds.unlistItem('i-1'),
  'worlds.provisions': (cf) => cf.worlds.provisions(),
  'worlds.provision': (cf) => cf.worlds.provision('p-1'),
  'worlds.achievements': (cf) => cf.worlds.achievements('t-1'),
  'worlds.seasons': (cf) => cf.worlds.seasons('t-1'),

  'activity.feed': (cf) => cf.activity.feed(),
  'activity.record': (cf) => cf.activity.record('a-1'),

  'identity.me': (cf) => cf.identity.me(),
}

/** Answers anything with a body every decoder can survive. */
function permissiveBody(): unknown {
  return {
    rates: [],
    rate: { rateScale: '1000000', usdScaled: null, usdSellScaled: null, usdBuyScaled: null, shardsPerCoinSellScaled: null, shardsPerCoinBuyScaled: null },
    spreadBps: 50,
    wallets: [],
    withdrawals: [],
    credits: [],
    assignments: [],
    listings: [],
    collections: [],
    orders: [],
    bids: [],
    offers: [],
    tokens: [],
    markets: [],
    titles: [],
    items: [],
    records: [],
    achievements: [],
    seasons: [],
    provisions: [],
    attempts: [],
    royalties: [],
    balances: [],
    nextCursor: null,
    replayed: false,
    pool: { yes: '0', no: '0', total: '0' },
    position: { yes: '0', no: '0' },
    priceUsdCents: '0',
    listing: { quantity: '1', price: null },
    order: { quantity: '1', amount: '0', feeAmount: '0', royaltyAmount: '0', sellerProceeds: '0', royalties: [] },
    offer: { amount: '0' },
    token: { supply: '0', cap: null, priceUsdCents: '0' },
    withdrawal: { amount: '0', fee: '0', net: '0' },
    record: { amount: null },
  }
}

test('every route in the table is reachable from the client, and no other request is made', async () => {
  const seen = new Map<string, { method: string; path: string }>()
  const fetch = (async (url: string, init: RequestInit) => {
    const parsed = new URL(String(url))
    seen.set(`${init.method} ${parsed.pathname}`, {
      method: String(init.method),
      path: parsed.pathname,
    })
    return new Response(JSON.stringify(permissiveBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  const cf = new CloudsForge({
    baseUrl: 'https://api.example.test',
    credential: apiKey('k'),
    fetch,
    retries: 0,
  })

  for (const name of ROUTE_NAMES) {
    await DRIVERS[name](cf)
  }

  // Every entry in ROUTES was reached, at the method and (templated) path it declares.
  assert.equal(seen.size, ROUTE_NAMES.length, 'one request per route, and no route unreached')
  for (const name of ROUTE_NAMES) {
    const route = ROUTES[name]
    const concrete = [...seen.values()].find(
      (request) => request.method === route.method && matches(route.path, request.path),
    )
    assert.ok(concrete, `${name} (${route.method} ${route.path}) was never requested`)
  }
})

test('a route with auth: none is called without a credential', async () => {
  const withAuth: string[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    if (headers['authorization']) withAuth.push(new URL(String(url)).pathname)
    return new Response(JSON.stringify(permissiveBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  const cf = new CloudsForge({
    baseUrl: 'https://api.example.test',
    credential: apiKey('k'),
    fetch,
    retries: 0,
  })

  for (const name of ROUTE_NAMES) {
    if (ROUTES[name].auth !== 'none') continue
    await DRIVERS[name](cf)
  }
  assert.deepEqual(withAuth, [], 'a public route must not receive an Authorization header')
})

/** `/v1/wallets/:id` matches `/v1/wallets/w-1`. */
function matches(template: string, concrete: string): boolean {
  const pattern = new RegExp(
    `^${template.replace(/:[A-Za-z][A-Za-z0-9]*/g, '[^/]+').replace(/\//g, '\\/')}$`,
  )
  return pattern.test(concrete)
}
