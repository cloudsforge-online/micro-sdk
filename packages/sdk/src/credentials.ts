/**
 * How the SDK gets an `Authorization` header.
 *
 * ## The seam, and why it is a seam rather than an implementation
 *
 * `docs/ecosystem/11-data-and-contract-strategy.md` says the public API is authenticated by "a
 * devplatform-issued key or OAuth client with scopes".
 *
 * **This block used to say `cloudsforge-devplatform` does not exist, and that it is item DEV-01
 * waiting on P11. It shipped.** `micro-devplatform` runs, its console is at
 * `https://developers.cloudsforge.online`, and the gateway forwards `/v1/apps`, `/v1/keys`,
 * `/v1/oauth-clients`, `/v1/organisations`, `/v1/projects`, `/v1/scopes` and
 * `/v1/webhook-endpoints` to it. **API keys are self-service.** The old sentence is left named
 * rather than deleted because it is why the three implementations below have the shape they do.
 *
 * What is still true is narrower, and it is the half that governs this file: **there is no token
 * endpoint to POST to.** devplatform deliberately does not mint tokens — signing one means signing
 * with the key the estate's JWKS publishes, which is identity's, so a devplatform-signed token
 * verifies nowhere; and giving devplatform its own key would create a second omnipotent issuer.
 * `devplatform/src/oauth.ts` sets out the seam: devplatform owns the client registry and answers
 * whether a `client_id`/`client_secret` pair is valid, identity owns the token endpoint and asks
 * it. `POST /internal/oauth/verify` is built; identity's half is not. So a default `tokenUrl` would
 * still be a URL this SDK made up, which is rule 4.
 *
 * A `Credential` is anything that can produce a bearer token on demand, and the three
 * implementations below are the three that can be written truthfully today.
 *
 *   - `apiKey(key)` — the key is the bearer token, and this is now the path a new integrator
 *     should take: mint one in the console. It is what every route in the estate already reads:
 *     `bearerFrom(headerOf(req, 'authorization'))`, unchanged in `wallet`, `market`, `mint`,
 *     `worlds`, `foresight`, `activity` and `ledger`. Nothing about the format is asserted here,
 *     because nothing about it needs to be: it is carried, not parsed.
 *   - `bearerToken(token)` — a token you obtained some other way, and the one the CLI uses.
 *   - `clientCredentials({ tokenUrl, clientId, clientSecret })` — RFC 6749 §4.4, with the token
 *     endpoint supplied by the CALLER rather than baked in, because the endpoint that will serve
 *     it is identity's and it is not built. It caches until expiry with a safety margin and
 *     refreshes once across concurrent callers. When identity grows the endpoint, the only change
 *     here is a default for `tokenUrl`, which is an additive one.
 *
 * ## What is deliberately absent
 *
 * There is no password grant and no wrapper around `identity`'s `POST /auth/login`. A third-party
 * application must never collect a CloudsForge password, and an SDK that made it one line away
 * would be inviting exactly that. The route exists; it is not this SDK's to offer.
 */

import { AuthError } from './errors.ts'

/**
 * Anything that can produce a bearer token.
 *
 * Async because a short-lived token must be refreshable without the caller rebuilding the client —
 * the same reason `runtime/packages/http`'s `token` option is async (`index.ts`).
 */
export interface Credential {
  /** A short label for diagnostics. Never the secret. */
  readonly kind: string
  /** The value for `Authorization: Bearer <…>`, or `undefined` for an anonymous call. */
  token(options?: { readonly signal?: AbortSignal | undefined }): Promise<string | undefined>
}

/** No credential. Public routes only; anything else answers 401. */
export function anonymous(): Credential {
  return { kind: 'anonymous', token: async () => undefined }
}

/**
 * A devplatform-issued API key, sent as the bearer token.
 *
 * The key is held in a closure and is not a property of the returned object, so it cannot be
 * reached by `JSON.stringify(client)` or printed by a debugger walking the client's fields. That
 * is not paranoia: an SDK's config object ends up in error reports.
 */
export function apiKey(key: string): Credential {
  const trimmed = key.trim()
  if (trimmed.length === 0) throw new AuthError('an API key must not be empty')
  return { kind: 'api-key', token: async () => trimmed }
}

/** A bearer token you already hold. */
export function bearerToken(token: string): Credential {
  const trimmed = token.trim()
  if (trimmed.length === 0) throw new AuthError('a bearer token must not be empty')
  return { kind: 'bearer', token: async () => trimmed }
}

export interface ClientCredentialsOptions {
  /**
   * The OAuth token endpoint.
   *
   * REQUIRED, with no default. `devplatform` ships and issues the client, but it deliberately
   * does not mint tokens — the token endpoint is identity's and is not built yet — so a default
   * would still be a URL this SDK made up. See the header of this file. When identity grows the
   * endpoint this gains a default and nothing else changes.
   */
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret: string
  /** Space-delimited on the wire, per RFC 6749 §3.3. */
  readonly scopes?: readonly string[]
  /** Refresh this long before expiry, so an in-flight request never carries a just-expired token. */
  readonly refreshMarginMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

interface CachedToken {
  readonly value: string
  readonly expiresAtMs: number
}

/**
 * OAuth 2.0 client credentials, RFC 6749 §4.4.
 *
 * Two properties worth stating because both are easy to get wrong:
 *
 * 1. **One refresh, not N.** Concurrent callers share the in-flight promise. Without that, a
 *    client waking up with ten queued requests sends ten token requests, and a token endpoint that
 *    rate-limits turns a cold start into an outage.
 * 2. **The secret never reaches a URL.** It goes in the form body. A secret in a query string is
 *    in the peer's access log, in every proxy between here and there, and in the referrer.
 */
export function clientCredentials(options: ClientCredentialsOptions): Credential {
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  const marginMs = options.refreshMarginMs ?? 30_000
  if (options.clientId.trim().length === 0) throw new AuthError('clientId must not be empty')
  if (options.clientSecret.trim().length === 0) throw new AuthError('clientSecret must not be empty')

  let cached: CachedToken | undefined
  let inFlight: Promise<CachedToken> | undefined

  async function request(signal: AbortSignal | undefined): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_secret: options.clientSecret,
    })
    if (options.scopes && options.scopes.length > 0) body.set('scope', options.scopes.join(' '))

    let response: Response
    try {
      response = await doFetch(options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw new AuthError(`the token endpoint could not be reached: ${String(err)}`)
    }

    const text = await response.text()
    if (!response.ok) {
      // The status and the OAuth `error` code, and nothing else. A token endpoint's body can echo
      // the request, and the request contains the client secret.
      throw new AuthError(`the token endpoint answered ${response.status}: ${oauthErrorCode(text)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new AuthError('the token endpoint did not answer with JSON')
    }
    const record = parsed as Record<string, unknown>
    const accessToken = record['access_token']
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AuthError('the token endpoint answered without an access_token')
    }
    // A missing `expires_in` is treated as one minute rather than for ever. Caching a token of
    // unknown lifetime indefinitely is how a client keeps presenting a revoked credential.
    const expiresIn = typeof record['expires_in'] === 'number' ? record['expires_in'] : 60
    return { value: accessToken, expiresAtMs: now() + Math.max(0, expiresIn * 1000) }
  }

  return {
    kind: 'client-credentials',
    async token(callOptions) {
      const current = cached
      if (current && current.expiresAtMs - marginMs > now()) return current.value
      if (!inFlight) {
        inFlight = request(callOptions?.signal).finally(() => {
          inFlight = undefined
        })
      }
      const fresh = await inFlight
      cached = fresh
      return fresh.value
    },
  }
}

function oauthErrorCode(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      const code = (parsed as Record<string, unknown>)['error']
      if (typeof code === 'string') return code
    }
  } catch {
    // Not JSON. Say so rather than echoing a body that may contain the request.
  }
  return 'no error code'
}
