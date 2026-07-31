/**
 * THE ROUTE TABLE. Every request this SDK can make is here, and nowhere else.
 *
 * WHY it is a table rather than a string literal at each call site:
 *
 * This estate has already shipped five clients built against a surface somebody imagined —
 * including one that returned 403 on every marketplace listing because it sent a token to a route
 * that has no `authenticate()` call and never wanted one. A public SDK is the worst place for that
 * failure: a third party cannot read the service source to find out that the method they called
 * does not exist, and a method that 404s is worse than a method that is absent, because the absent
 * one sends them to the documentation instead of to a support ticket.
 *
 * So every entry below carries `verifiedAt` — the exact `path:line` in the owning service where
 * the route is registered — and `routes.test.ts` asserts that every method the SDK exposes appears
 * here. The citations were read, one at a time, against the services at the commit this was
 * written. They are not decoration: they are how the next person re-checks the claim.
 *
 * `auth` is read off the handler, not off intuition:
 *   - 'none'    — the handler makes no `authenticate()` call at all. Sending a token is harmless
 *                 but pointless, and REQUIRING one would be the 403 defect all over again.
 *   - 'token'   — the handler authenticates and accepts a user OR a service principal.
 *   - 'user'    — the handler calls a helper that refuses a service token outright.
 *
 * `idempotency: 'required'` means the handler REFUSES the request without an `Idempotency-Key`
 * header. That is not a convention this SDK invented; it is a 400 from the service, and the four
 * wallet money routes and the five market mutations below each throw it by name.
 */

export type RouteAuth = 'none' | 'token' | 'user'
export type RouteIdempotency = 'required' | 'none'

export interface RouteSpec {
  /** The uppercase HTTP method. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** The path as the owning service registers it, `:name` for a path parameter. */
  readonly path: string
  /** The service that owns the route. Informational — the SDK talks to one gateway. */
  readonly service:
    | 'wallet'
    | 'market'
    | 'mint'
    | 'pricing'
    | 'foresight'
    | 'worlds'
    | 'activity'
    | 'identity'
  readonly auth: RouteAuth
  readonly idempotency: RouteIdempotency
  /** `<repo>/src/server.ts:<line>` where the route is registered. Re-check this, do not trust it. */
  readonly verifiedAt: string
}

/**
 * `as const` so the keys are a closed union: `routes.test.ts` compares that union against the
 * methods the client exposes, and a method added without a route entry is a compile error before
 * it is a test failure.
 */
export const ROUTES = {
  /* ------------------------------------------------------------------ pricing */

  'pricing.rates': {
    method: 'GET',
    path: '/rates',
    service: 'pricing',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'pricing/src/server.ts:312',
  },
  'pricing.rate': {
    method: 'GET',
    path: '/rates/:asset',
    service: 'pricing',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'pricing/src/server.ts:321',
  },

  /* ------------------------------------------------------------------ wallet */

  'wallet.list': {
    method: 'GET',
    path: '/v1/wallets',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:440',
  },
  'wallet.register': {
    method: 'POST',
    path: '/v1/wallets',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:463',
  },
  'wallet.get': {
    method: 'GET',
    path: '/v1/wallets/:id',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:501',
  },
  'wallet.update': {
    method: 'PATCH',
    path: '/v1/wallets/:id',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:510',
  },
  'wallet.verify': {
    method: 'POST',
    path: '/v1/wallets/verify',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:528',
  },
  'wallet.grantAuthorisation': {
    method: 'POST',
    path: '/v1/wallets/:id/authorisations',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:557',
  },
  'wallet.revokeAuthorisation': {
    method: 'DELETE',
    path: '/v1/wallets/:id/authorisations/:authorisation',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:578',
  },

  'deposits.assign': {
    method: 'POST',
    path: '/v1/deposits',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:604',
  },
  'deposits.list': {
    method: 'GET',
    path: '/v1/deposits',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:624',
  },
  'deposits.credits': {
    method: 'GET',
    path: '/v1/deposits/credits',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:631',
  },

  // `requireIdempotencyKey('POST /v1/withdrawals', …)` at wallet/src/server.ts:649.
  'withdrawals.request': {
    method: 'POST',
    path: '/v1/withdrawals',
    service: 'wallet',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'wallet/src/server.ts:645',
  },
  'withdrawals.list': {
    method: 'GET',
    path: '/v1/withdrawals',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:685',
  },
  'withdrawals.get': {
    method: 'GET',
    path: '/v1/withdrawals/:id',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:697',
  },

  // wallet/src/server.ts:712 — "**The line this whole service exists to add.** forge-pay's /spend
  // accepts a missing key." The SDK does not offer a way to omit it.
  'money.spend': {
    method: 'POST',
    path: '/v1/spend',
    service: 'wallet',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'wallet/src/server.ts:707',
  },
  'money.transfer': {
    method: 'POST',
    path: '/v1/transfers',
    service: 'wallet',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'wallet/src/server.ts:734',
  },
  'money.convert': {
    method: 'POST',
    path: '/v1/conversions',
    service: 'wallet',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'wallet/src/server.ts:761',
  },

  'portfolio.get': {
    method: 'GET',
    path: '/v1/portfolio',
    service: 'wallet',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'wallet/src/server.ts:790',
  },

  /* ------------------------------------------------------------------ market */

  'market.collections': {
    method: 'GET',
    path: '/v1/collections',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:596',
  },
  'market.createCollection': {
    method: 'POST',
    path: '/v1/collections',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:602',
  },
  // No `authenticate()` in the handler. THE 403 DEFECT: a client that demanded a token here is
  // what made every marketplace listing unreadable to a signed-out browser.
  'market.listings': {
    method: 'GET',
    path: '/v1/listings',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:618',
  },
  'market.listing': {
    method: 'GET',
    path: '/v1/listings/:id',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:636',
  },
  // `withIdempotentRoute` at market/src/server.ts:682 — 400 without the header.
  'market.createListing': {
    method: 'POST',
    path: '/v1/listings',
    service: 'market',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'market/src/server.ts:651',
  },
  'market.activateListing': {
    method: 'POST',
    path: '/v1/listings/:id/activate',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:742',
  },
  'market.cancelListing': {
    method: 'DELETE',
    path: '/v1/listings/:id',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:776',
  },
  'market.risk': {
    method: 'GET',
    path: '/v1/listings/:id/risk',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:790',
  },
  'market.buy': {
    method: 'POST',
    path: '/v1/listings/:id/buy',
    service: 'market',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'market/src/server.ts:818',
  },
  'market.bids': {
    method: 'GET',
    path: '/v1/listings/:id/bids',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:846',
  },
  'market.placeBid': {
    method: 'POST',
    path: '/v1/listings/:id/bids',
    service: 'market',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'market/src/server.ts:863',
  },
  'market.offers': {
    method: 'GET',
    path: '/v1/listings/:id/offers',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:893',
  },
  'market.makeOffer': {
    method: 'POST',
    path: '/v1/listings/:id/offers',
    service: 'market',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'market/src/server.ts:898',
  },
  'market.withdrawOffer': {
    method: 'DELETE',
    path: '/v1/offers/:id',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:917',
  },
  'market.acceptOffer': {
    method: 'POST',
    path: '/v1/offers/:id/accept',
    service: 'market',
    auth: 'token',
    idempotency: 'required',
    verifiedAt: 'market/src/server.ts:931',
  },
  'market.orders': {
    method: 'GET',
    path: '/v1/orders',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:969',
  },
  'market.order': {
    method: 'GET',
    path: '/v1/orders/:id',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:980',
  },
  'market.openDispute': {
    method: 'POST',
    path: '/v1/orders/:id/disputes',
    service: 'market',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:993',
  },
  'market.verification': {
    method: 'GET',
    path: '/v1/verifications/:urn',
    service: 'market',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'market/src/server.ts:1091',
  },

  /* ------------------------------------------------------------------ mint */

  'mint.catalogue': {
    method: 'GET',
    path: '/v1/catalogue',
    service: 'mint',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:340',
  },
  'mint.createToken': {
    method: 'POST',
    path: '/v1/tokens',
    service: 'mint',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:359',
  },
  'mint.tokens': {
    method: 'GET',
    path: '/v1/tokens',
    service: 'mint',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:417',
  },
  'mint.token': {
    method: 'GET',
    path: '/v1/tokens/:id',
    service: 'mint',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:430',
  },
  'mint.pay': {
    method: 'POST',
    path: '/v1/tokens/:id/pay',
    service: 'mint',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:454',
  },
  'mint.deploy': {
    method: 'POST',
    path: '/v1/tokens/:id/deploy',
    service: 'mint',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:491',
  },
  'mint.putPage': {
    method: 'PUT',
    path: '/v1/tokens/:id/page',
    service: 'mint',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:546',
  },
  'mint.page': {
    method: 'GET',
    path: '/v1/tokens/:id/page',
    service: 'mint',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'mint/src/server.ts:572',
  },

  /* ------------------------------------------------------------------ foresight */

  'foresight.categories': {
    method: 'GET',
    path: '/categories',
    service: 'foresight',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'foresight/src/server.ts:398',
  },
  'foresight.markets': {
    method: 'GET',
    path: '/markets',
    service: 'foresight',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'foresight/src/server.ts:409',
  },
  'foresight.market': {
    method: 'GET',
    path: '/markets/:id',
    service: 'foresight',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'foresight/src/server.ts:424',
  },
  'foresight.position': {
    method: 'GET',
    path: '/markets/:id/positions/:address',
    service: 'foresight',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'foresight/src/server.ts:455',
  },
  'foresight.stakeIntent': {
    method: 'POST',
    path: '/markets/:id/stake-intent',
    service: 'foresight',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'foresight/src/server.ts:490',
  },

  /* ------------------------------------------------------------------ worlds */

  'worlds.titles': {
    method: 'GET',
    path: '/v1/titles',
    service: 'worlds',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:467',
  },
  'worlds.player': {
    method: 'GET',
    path: '/v1/players/me',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:524',
  },
  'worlds.updatePlayer': {
    method: 'PUT',
    path: '/v1/players/me',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:551',
  },
  'worlds.equip': {
    method: 'PUT',
    path: '/v1/players/me/cosmetics',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:576',
  },
  'worlds.inventory': {
    method: 'GET',
    path: '/v1/players/me/inventory',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:598',
  },
  'worlds.listItem': {
    method: 'POST',
    path: '/v1/players/me/inventory/:id/list',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:617',
  },
  'worlds.unlistItem': {
    method: 'DELETE',
    path: '/v1/players/me/inventory/:id/list',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:631',
  },
  'worlds.provisions': {
    method: 'GET',
    path: '/v1/provisions',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:642',
  },
  'worlds.provision': {
    method: 'GET',
    path: '/v1/provisions/:id',
    service: 'worlds',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:683',
  },
  'worlds.achievements': {
    method: 'GET',
    path: '/v1/titles/:id/achievements',
    service: 'worlds',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:701',
  },
  'worlds.seasons': {
    method: 'GET',
    path: '/v1/titles/:id/seasons',
    service: 'worlds',
    auth: 'none',
    idempotency: 'none',
    verifiedAt: 'worlds/src/server.ts:755',
  },

  /* ------------------------------------------------------------------ activity */

  'activity.feed': {
    method: 'GET',
    path: '/feed',
    service: 'activity',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'activity/src/server.ts:318',
  },
  'activity.record': {
    method: 'GET',
    path: '/feed/:id',
    service: 'activity',
    auth: 'token',
    idempotency: 'none',
    verifiedAt: 'activity/src/server.ts:351',
  },

  /* ------------------------------------------------------------------ identity */

  // `authenticateUser` refuses a service principal outright — identity/src/server.ts:540. An API
  // key is not a user, so this is the one route in the SDK a machine credential cannot call, and
  // `auth: 'user'` is how the SDK says so before the 403 does.
  'identity.me': {
    method: 'GET',
    path: '/auth/me',
    service: 'identity',
    auth: 'user',
    idempotency: 'none',
    verifiedAt: 'identity/src/server.ts:891',
  },
} as const satisfies Readonly<Record<string, RouteSpec>>

export type RouteName = keyof typeof ROUTES

/** Every route name, for tests and for `cloudsforge routes`. */
export const ROUTE_NAMES = Object.keys(ROUTES) as readonly RouteName[]

/**
 * Fill `:name` segments, percent-encoding each value.
 *
 * Encoding matters more than it looks. A market verification is keyed by a URN — `cf:market:…` —
 * and an unencoded colon in a path segment is a different path. `market/src/server.ts:1093`
 * decodes it on the way in, so it must be encoded on the way out.
 */
export function fillPath(path: string, params: Readonly<Record<string, string>> = {}): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = params[name]
    if (value === undefined || value === '') {
      throw new TypeError(`path parameter '${name}' is required by ${path}`)
    }
    return encodeURIComponent(value)
  })
}
