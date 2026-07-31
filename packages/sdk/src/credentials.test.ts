import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthError } from './errors.ts'
import { anonymous, apiKey, bearerToken, clientCredentials } from './credentials.ts'

test('an API key is the bearer token, and is not a property anybody can print', async () => {
  const credential = apiKey('cfk_live_secret')
  assert.equal(await credential.token(), 'cfk_live_secret')
  // A config object ends up in error reports. The secret must not be reachable by walking it.
  assert.equal(JSON.stringify(credential), '{"kind":"api-key"}')
  assert.equal(Object.values(credential).includes('cfk_live_secret'), false)
})

test('an empty credential is refused at construction rather than sending "Bearer "', () => {
  assert.throws(() => apiKey('   '), AuthError)
  assert.throws(() => bearerToken(''), AuthError)
})

test('anonymous produces no token at all', async () => {
  assert.equal(await anonymous().token(), undefined)
})

/* ------------------------------------------------------------------ client credentials */

function tokenEndpoint(script: readonly (() => Response)[]): {
  fetch: typeof globalThis.fetch
  bodies: string[]
  urls: string[]
} {
  const bodies: string[] = []
  const urls: string[] = []
  let index = 0
  const fetch = (async (url: string, init: RequestInit) => {
    urls.push(String(url))
    bodies.push(String(init.body))
    const next = script[Math.min(index, script.length - 1)]
    index += 1
    return next!()
  }) as unknown as typeof globalThis.fetch
  return { fetch, bodies, urls }
}

function tokenResponse(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('the client secret goes in the form body, never in the URL', async () => {
  const { fetch, bodies, urls } = tokenEndpoint([tokenResponse({ access_token: 't1', expires_in: 3600 })])
  const credential = clientCredentials({
    tokenUrl: 'https://auth.example.test/oauth/token',
    clientId: 'client-1',
    clientSecret: 'shhh',
    scopes: ['wallet:read', 'market:read'],
    fetch,
  })
  assert.equal(await credential.token(), 't1')
  // A secret in a query string is in the peer's access log and in every proxy between here and it.
  assert.equal(urls[0], 'https://auth.example.test/oauth/token')
  assert.ok(!urls[0]!.includes('shhh'))
  const form = new URLSearchParams(bodies[0])
  assert.equal(form.get('grant_type'), 'client_credentials')
  assert.equal(form.get('client_secret'), 'shhh')
  assert.equal(form.get('scope'), 'wallet:read market:read')
})

test('the token is cached until its expiry, minus the refresh margin', async () => {
  let clock = 0
  const { fetch, bodies } = tokenEndpoint([tokenResponse({ access_token: 't1', expires_in: 100 })])
  const credential = clientCredentials({
    tokenUrl: 'https://auth.example.test/t',
    clientId: 'c',
    clientSecret: 's',
    refreshMarginMs: 10_000,
    fetch,
    now: () => clock,
  })
  await credential.token()
  clock = 80_000
  await credential.token()
  assert.equal(bodies.length, 1, 'a cached token must not be re-fetched')
  clock = 95_000 // inside the 10s margin before the 100s expiry
  await credential.token()
  assert.equal(bodies.length, 2, 'the margin must force a refresh before the token dies')
})

test('concurrent callers share one refresh, not N', async () => {
  // A client waking up with ten queued requests must not send ten token requests. A token endpoint
  // that rate-limits turns a cold start into an outage otherwise.
  const { fetch, bodies } = tokenEndpoint([tokenResponse({ access_token: 't1', expires_in: 3600 })])
  const credential = clientCredentials({
    tokenUrl: 'https://auth.example.test/t',
    clientId: 'c',
    clientSecret: 's',
    fetch,
  })
  const tokens = await Promise.all(Array.from({ length: 10 }, () => credential.token()))
  assert.deepEqual(new Set(tokens), new Set(['t1']))
  assert.equal(bodies.length, 1)
})

test('a missing expires_in is treated as a minute, not as for ever', async () => {
  let clock = 0
  const { fetch, bodies } = tokenEndpoint([tokenResponse({ access_token: 't1' })])
  const credential = clientCredentials({
    tokenUrl: 'https://auth.example.test/t',
    clientId: 'c',
    clientSecret: 's',
    refreshMarginMs: 0,
    fetch,
    now: () => clock,
  })
  await credential.token()
  clock = 61_000
  await credential.token()
  // Caching a token of unknown lifetime for ever is how a client keeps presenting a revoked one.
  assert.equal(bodies.length, 2)
})

test('a token endpoint failure reports the OAuth code and NOT the body', async () => {
  // The body of a token error can echo the request, and the request contains the client secret.
  const { fetch } = tokenEndpoint([
    tokenResponse({ error: 'invalid_client', echoed_request: 'client_secret=shhh' }, 401),
  ])
  const credential = clientCredentials({
    tokenUrl: 'https://auth.example.test/t',
    clientId: 'c',
    clientSecret: 'shhh',
    fetch,
  })
  const err = await credential.token().then(() => undefined, (e: unknown) => e)
  assert.ok(err instanceof AuthError)
  assert.match(err.message, /401/)
  assert.match(err.message, /invalid_client/)
  assert.ok(!err.message.includes('shhh'), 'the secret must never reach an error message')
})

test('an answer with no access_token is an AuthError, not a Bearer undefined', async () => {
  const { fetch } = tokenEndpoint([tokenResponse({ token_type: 'bearer' })])
  await assert.rejects(
    () =>
      clientCredentials({
        tokenUrl: 'https://auth.example.test/t',
        clientId: 'c',
        clientSecret: 's',
        fetch,
      }).token(),
    AuthError,
  )
})

test('an unreachable token endpoint is an AuthError naming the failure', async () => {
  const fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch
  await assert.rejects(
    () =>
      clientCredentials({
        tokenUrl: 'https://auth.example.test/t',
        clientId: 'c',
        clientSecret: 's',
        fetch,
      }).token(),
    AuthError,
  )
})

test('an empty client id or secret is refused at construction', () => {
  const base = { tokenUrl: 'https://auth.example.test/t', clientId: 'c', clientSecret: 's' }
  assert.throws(() => clientCredentials({ ...base, clientId: ' ' }), AuthError)
  assert.throws(() => clientCredentials({ ...base, clientSecret: '' }), AuthError)
})

test('a failed refresh does not poison the next attempt', async () => {
  let index = 0
  const fetch = (async () => {
    index += 1
    if (index === 1) throw new Error('transient')
    return new Response(JSON.stringify({ access_token: 't2', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  const credential = clientCredentials({
    tokenUrl: 'https://auth.example.test/t',
    clientId: 'c',
    clientSecret: 's',
    fetch,
  })
  await assert.rejects(() => credential.token(), AuthError)
  assert.equal(await credential.token(), 't2')
})
