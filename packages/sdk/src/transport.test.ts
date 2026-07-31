import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError, TimeoutError, TransportError, UsageError } from './errors.ts'
import { apiKey, anonymous } from './credentials.ts'
import { ROUTES } from './routes.ts'
import { Transport, type TransportOptions } from './transport.ts'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

/**
 * A fetch that answers from a script and records what it was asked.
 *
 * The script holds FACTORIES rather than `Response` objects. A `Response` body can be read once,
 * and the last entry is repeated for every further attempt — so a shared instance would make the
 * second attempt fail with "Body has already been read" instead of with the status the test meant
 * to script. That is a bug in the test rig that looks exactly like a bug in the retry loop.
 */
function scripted(responses: readonly ((() => Response) | Error)[]): {
  fetch: typeof globalThis.fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  let index = 0
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return next!()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
}

function raw(status: number, body: string | null, headers: Record<string, string> = {}): () => Response {
  return () => new Response(body, { status, headers })
}

function transport(fetch: typeof globalThis.fetch, extra: Partial<TransportOptions> = {}): Transport {
  return new Transport({
    baseUrl: 'https://api.example.test',
    fetch,
    // No real waiting anywhere in this file.
    sleep: async () => {},
    random: () => 0.5,
    ...extra,
  })
}

/* ------------------------------------------------------------------ retries */

test('a 500 is retried and the second attempt is returned', async () => {
  const { fetch, calls } = scripted([json(500, { error: { code: 'boom', message: 'x' } }), json(200, { ok: true })])
  const result = await transport(fetch).call<{ ok: boolean }>('pricing.rates', ROUTES['pricing.rates'])
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 2)
})

test('a 4xx is NEVER retried — the peer decided', async () => {
  const { fetch, calls } = scripted([json(400, { error: { code: 'bad_amount', message: 'send a string' } })])
  await assert.rejects(
    () => transport(fetch).call('pricing.rates', ROUTES['pricing.rates']),
    (err: unknown) => err instanceof ApiError && err.status === 400 && err.peerDecided,
  )
  assert.equal(calls.length, 1, 'a 400 must cost exactly one request')
})

test('429 and 408 ARE retried — they mean later, not no', async () => {
  for (const status of [408, 425, 429]) {
    const { fetch, calls } = scripted([json(status, { error: { code: 'slow', message: 'x' } }), json(200, {})])
    await transport(fetch).call('pricing.rates', ROUTES['pricing.rates'])
    assert.equal(calls.length, 2, `${status} should have been retried`)
  }
})

test('a request with no idempotency key and a non-idempotent method is attempted ONCE', async () => {
  // PATCH is not idempotent by HTTP semantics and the SDK derives a key only for POST, so
  // wallet.update is the route where the guard is observable. Retrying it would be the SDK
  // deciding, on the caller's behalf, that applying an unknown partial update twice is safe.
  const { fetch, calls } = scripted([json(503, { error: { code: 'down', message: 'x' } })])
  await assert.rejects(() =>
    transport(fetch, { retries: 3, credential: apiKey('k') }).call('wallet.update', ROUTES['wallet.update'], {
      params: { id: 'w1' },
      body: { label: 'x' },
    }),
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.headers['idempotency-key'], undefined)
})

test('a POST always carries a derived key, which is what makes retrying it safe', async () => {
  const { fetch, calls } = scripted([json(503, { error: { code: 'down', message: 'x' } })])
  await assert.rejects(() =>
    transport(fetch, { retries: 3 }).call('foresight.stakeIntent', ROUTES['foresight.stakeIntent'], {
      params: { id: 'm1' },
      body: { amount: '1', outcome: 0 },
    }),
  )
  assert.equal(calls.length, 4)
  assert.ok(calls[0]?.headers['idempotency-key'], 'a POST must carry a derived key')
})

test('every attempt at one POST carries the SAME idempotency key', async () => {
  const { fetch, calls } = scripted([
    json(503, { error: { code: 'down', message: 'x' } }),
    json(503, { error: { code: 'down', message: 'x' } }),
    json(201, { ok: true }),
  ])
  await transport(fetch).call('money.spend', ROUTES['money.spend'], {
    body: { amount: '100', reason: 'test' },
  })
  const keys = new Set(calls.map((call) => call.headers['idempotency-key']))
  assert.equal(keys.size, 1, 'a retry with a fresh key is a second debit')
  assert.equal(calls.length, 3)
})

test('retries stop at the configured bound', async () => {
  const { fetch, calls } = scripted([json(500, { error: { code: 'x', message: 'y' } })])
  await assert.rejects(() =>
    transport(fetch, { retries: 1 }).call('pricing.rates', ROUTES['pricing.rates']),
  )
  assert.equal(calls.length, 2)
})

test('a Retry-After overrides the backoff formula', async () => {
  const slept: number[] = []
  const { fetch } = scripted([
    json(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '2' }),
    json(200, {}),
  ])
  await new Transport({
    baseUrl: 'https://api.example.test',
    fetch,
    sleep: async (ms) => {
      slept.push(ms)
    },
    random: () => 1,
    now: () => 0,
  }).call('pricing.rates', ROUTES['pricing.rates'])
  assert.deepEqual(slept, [2000])
})

/* ------------------------------------------------------------------ deadlines */

test('the deadline is absolute across attempts, not per attempt', async () => {
  let clock = 0
  const { fetch, calls } = scripted([json(500, { error: { code: 'x', message: 'y' } })])
  await assert.rejects(() =>
    new Transport({
      baseUrl: 'https://api.example.test',
      fetch,
      deadlineMs: 1_000,
      retries: 10,
      random: () => 0,
      now: () => clock,
      // Each "attempt" burns 400ms of the budget, so the third cannot start.
      sleep: async () => {
        clock += 400
      },
    }).call('pricing.rates', ROUTES['pricing.rates']),
  )
  assert.ok(calls.length < 11, 'the deadline must bound the attempts')
  assert.equal(calls.length, 3)
})

test('a timeout surfaces as TimeoutError, not as a peer error', async () => {
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const { fetch } = scripted([aborted])
  await assert.rejects(
    () => transport(fetch, { deadlineMs: 1, retries: 0 }).call('pricing.rates', ROUTES['pricing.rates']),
    (err: unknown) => err instanceof TimeoutError || err instanceof TransportError,
  )
})

test('a transport fault is a TransportError and says which call failed', async () => {
  const { fetch } = scripted([new Error('ECONNREFUSED')])
  await assert.rejects(
    () => transport(fetch, { retries: 0 }).call('pricing.rates', ROUTES['pricing.rates']),
    (err: unknown) => err instanceof TransportError && err.message.includes('/rates'),
  )
})

/* ------------------------------------------------------------------ the request id */

test('the request id comes off the BODY first, then the header', async () => {
  const { fetch } = scripted([
    json(
      404,
      { error: { code: 'wallet_not_found', message: 'no such wallet', requestId: 'body-id' } },
      { 'x-request-id': 'header-id' },
    ),
  ])
  await assert.rejects(
    () =>
      transport(fetch).call('wallet.get', ROUTES['wallet.get'], {
        params: { id: 'w1' },
      }),
    (err: unknown) => err instanceof ApiError && err.requestId === 'body-id',
  )
})

test('a header id is used when the body carries none', async () => {
  const { fetch } = scripted([raw(502, '<html>bad gateway</html>', { 'x-request-id': 'gw-1' })])
  await assert.rejects(
    () => transport(fetch, { retries: 0 }).call('pricing.rates', ROUTES['pricing.rates']),
    (err: unknown) => err instanceof ApiError && err.requestId === 'gw-1' && err.code === 'unknown',
  )
})

test('toString prints the request id, because it is the only thing a developer can quote', async () => {
  const { fetch } = scripted([json(403, { error: { code: 'policy_denied', message: 'refused', requestId: 'r-9' } })])
  const err = await transport(fetch)
    .call('market.buy', ROUTES['market.buy'], { params: { id: 'l1' }, body: { amount: '1' } })
    .then(() => undefined, (e: unknown) => e)
  assert.ok(err instanceof ApiError)
  assert.match(err.toString(), /request id r-9/)
  assert.ok(err.isForbidden)
})

/* ------------------------------------------------------------------ credentials */

test('no Authorization header is sent to a route that makes no authenticate() call', async () => {
  // THE 403 DEFECT, as a test. A client that sent a token to every route is what made every
  // marketplace listing unreadable.
  const { fetch, calls } = scripted([json(200, { listings: [] })])
  await transport(fetch, { credential: apiKey('secret-key') }).call(
    'market.listings',
    ROUTES['market.listings'],
  )
  assert.equal(calls[0]?.headers['authorization'], undefined)
})

test('the Authorization header IS sent to a route that authenticates', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await transport(fetch, { credential: apiKey('secret-key') }).call(
    'portfolio.get',
    ROUTES['portfolio.get'],
  )
  assert.equal(calls[0]?.headers['authorization'], 'Bearer secret-key')
})

test('an anonymous credential sends nothing even on an authenticated route', async () => {
  const { fetch, calls } = scripted([json(401, { error: { code: 'unauthorised', message: 'x' } })])
  await assert.rejects(() =>
    transport(fetch, { credential: anonymous() }).call('portfolio.get', ROUTES['portfolio.get']),
  )
  assert.equal(calls[0]?.headers['authorization'], undefined)
})

test('a default Authorization header is refused at construction', () => {
  assert.throws(
    () => new Transport({ baseUrl: 'https://x.test', headers: { Authorization: 'Bearer nope' } }),
    UsageError,
  )
})

/* ------------------------------------------------------------------ URLs and bodies */

test('a path parameter is percent-encoded, so a URN survives the path', async () => {
  const { fetch, calls } = scripted([json(200, { verification: null })])
  await transport(fetch).call('market.verification', ROUTES['market.verification'], {
    params: { urn: 'cf:market:item:42' },
  })
  assert.match(calls[0]?.url ?? '', /\/v1\/verifications\/cf%3Amarket%3Aitem%3A42$/)
})

test('a missing path parameter throws before any I/O', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await assert.rejects(() => transport(fetch).call('wallet.get', ROUTES['wallet.get'], {}), TypeError)
  assert.equal(calls.length, 0)
})

test('an undefined query value is omitted rather than sent as "undefined"', async () => {
  const { fetch, calls } = scripted([json(200, { wallets: [], nextCursor: null })])
  await transport(fetch, { credential: apiKey('k') }).call('wallet.list', ROUTES['wallet.list'], {
    query: { limit: 10, cursor: undefined },
  })
  assert.match(calls[0]?.url ?? '', /\?limit=10$/)
})

test('pathPrefix is applied once, and is the seam for a gateway mount point', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await transport(fetch, { pathPrefix: '/public' }).call('pricing.rates', ROUTES['pricing.rates'])
  assert.equal(calls[0]?.url, 'https://api.example.test/public/rates')
})

test('a 204 resolves to undefined rather than throwing on an empty body', async () => {
  const { fetch } = scripted([raw(204, null)])
  const result = await transport(fetch, { credential: apiKey('k') }).call(
    'market.cancelListing',
    ROUTES['market.cancelListing'],
    { params: { id: 'l1' } },
  )
  assert.equal(result, undefined)
})

test('a 200 that is not JSON is an ApiError naming the body, not a raw SyntaxError', async () => {
  const { fetch } = scripted([raw(200, 'not json')])
  await assert.rejects(
    () => transport(fetch).call('pricing.rates', ROUTES['pricing.rates']),
    (err: unknown) => err instanceof ApiError && err.code === 'bad_response',
  )
})

test('every request carries the deadline it has left', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await transport(fetch, { deadlineMs: 5_000 }).call('pricing.rates', ROUTES['pricing.rates'])
  const deadline = Number(calls[0]?.headers['x-deadline-ms'])
  assert.ok(deadline > 0 && deadline <= 5_000)
})

test('the user agent names the SDK, and a caller can append to it', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await transport(fetch, { userAgent: 'acme-bot/2' }).call('pricing.rates', ROUTES['pricing.rates'])
  assert.match(calls[0]?.headers['user-agent'] ?? '', /^cloudsforge-sdk\/\d+\.\d+\.\d+ acme-bot\/2$/)
})

test('a redirect is refused rather than followed with the Authorization header attached', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await transport(fetch, { credential: apiKey('k') }).call('portfolio.get', ROUTES['portfolio.get'])
  assert.equal(calls.length, 1)
  // The guarantee lives in the fetch init; assert it is asked for rather than trusting the comment.
  const init: RequestInit[] = []
  const recordingFetch = (async (_url: string, options: RequestInit) => {
    init.push(options)
    return json(200, {})()
  }) as unknown as typeof globalThis.fetch
  await transport(recordingFetch).call('pricing.rates', ROUTES['pricing.rates'])
  assert.equal(init[0]?.redirect, 'error')
})

/* ------------------------------------------------------------------ observability */

test('onRequest reports every attempt with its outcome and request id', async () => {
  const events: string[] = []
  const { fetch } = scripted([
    json(500, { error: { code: 'x', message: 'y', requestId: 'r1' } }),
    json(200, {}, { 'x-request-id': 'r2' }),
  ])
  await transport(fetch, {
    onRequest: (event) => events.push(`${event.attempt}:${event.outcome}:${event.requestId ?? '-'}`),
  }).call('pricing.rates', ROUTES['pricing.rates'])
  assert.deepEqual(events, ['1:server_error:r1', '2:ok:r2'])
})

/* ------------------------------------------------------------------ construction */

test('a non-http baseUrl is refused at construction, not at the first call', () => {
  assert.throws(() => new Transport({ baseUrl: 'api.example.test' }), UsageError)
  assert.throws(() => new Transport({ baseUrl: 'https://x.test', deadlineMs: 0 }), UsageError)
  assert.throws(() => new Transport({ baseUrl: 'https://x.test', retries: -1 }), UsageError)
})

test('a caller-supplied idempotency key is validated and used verbatim', async () => {
  const { fetch, calls } = scripted([json(201, {})])
  await transport(fetch, { credential: apiKey('k') }).call('money.spend', ROUTES['money.spend'], {
    body: { amount: '1', reason: 'x' },
    idempotencyKey: 'invoice-000123',
  })
  assert.equal(calls[0]?.headers['idempotency-key'], 'invoice-000123')
})

test('an idempotency key on a GET is a usage error, not a silently ignored header', async () => {
  const { fetch, calls } = scripted([json(200, {})])
  await assert.rejects(
    () =>
      transport(fetch).call('pricing.rates', ROUTES['pricing.rates'], {
        idempotencyKey: 'something-long-enough',
      }),
    UsageError,
  )
  assert.equal(calls.length, 0)
})
