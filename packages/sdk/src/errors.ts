/**
 * The errors a caller catches.
 *
 * ONE RULE ABOVE EVERY OTHER: an error carries the request id.
 *
 * Every CloudsForge service answers a failure with the same body — `{ error: { code, message,
 * requestId } }` — and every one of them puts the id there deliberately. `wallet/src/server.ts`
 * says why, at line 1058: "The id in the body rather than only in the header is what makes a
 * support conversation work". The id is the only string a developer can paste into a ticket that
 * joins their failed call to a log line, a trace and an incident. An SDK that swallowed it would
 * make every support conversation start with "can you reproduce it".
 *
 * So `ApiError.requestId` reads the body first and falls back to the `x-request-id` response
 * header, and `toString()` prints it.
 */

/** Base class, so `catch (e) { if (e instanceof CloudsForgeError) … }` covers everything here. */
export class CloudsForgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudsForgeError'
  }
}

/** The shape every service uses for a failure. Narrowed defensively — a gateway may answer too. */
export interface ApiErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId?: string
}

/**
 * The peer answered, and the answer was not a success.
 *
 * `peerDecided` is `runtime/packages/http`'s rule, kept verbatim (`index.ts`): 4xx means the
 * peer decided and the same request will get the same answer, 5xx means we do not know. It is the
 * predicate the retry loop consults, and it is public because callers want it too — "should I show
 * this to the user or retry it myself" is the same question.
 */
export class ApiError extends CloudsForgeError {
  readonly status: number
  /** The service's error code — `bad_amount`, `policy_denied`, `wallet_not_found`. */
  readonly code: string
  /** The id to quote at support. `undefined` only if the peer sent neither body nor header. */
  readonly requestId: string | undefined
  readonly method: string
  /** The path, never the full URL: a URL can carry a query string, and a query can carry a token. */
  readonly path: string
  /** At most 2 KiB of the response body, for a developer staring at an unfamiliar failure. */
  readonly body: string
  /** Present when the peer sent `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined

  constructor(args: {
    status: number
    code: string
    message: string
    method: string
    path: string
    body: string
    requestId?: string | undefined
    retryAfterMs?: number | undefined
  }) {
    super(`${args.method} ${args.path} → ${args.status} ${args.code}: ${args.message}`)
    this.name = 'ApiError'
    this.status = args.status
    this.code = args.code
    this.requestId = args.requestId
    this.method = args.method
    this.path = args.path
    this.body = args.body
    this.retryAfterMs = args.retryAfterMs
  }

  /** 4xx: the peer decided. 5xx: we do not know. Never retried when true. */
  get peerDecided(): boolean {
    return this.status >= 400 && this.status < 500
  }

  /** The credential was missing, malformed or expired. */
  get isUnauthenticated(): boolean {
    return this.status === 401
  }

  /** The credential was understood and refused. Re-authenticating will not help. */
  get isForbidden(): boolean {
    return this.status === 403
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  /**
   * The idempotency key was reused with a different body.
   *
   * Called out because it is the one 4xx that means the CALLER has a bug in its own retry logic
   * rather than in its request, and the distinction is invisible from the status alone.
   */
  get isIdempotencyConflict(): boolean {
    return this.status === 409
  }

  get isRateLimited(): boolean {
    return this.status === 429
  }

  override toString(): string {
    return this.requestId ? `${this.message} (request id ${this.requestId})` : this.message
  }
}

/** The deadline expired. Not a peer decision: the request may or may not have been performed. */
export class TimeoutError extends CloudsForgeError {
  readonly method: string
  readonly path: string
  readonly deadlineMs: number

  constructor(method: string, path: string, deadlineMs: number) {
    super(`${method} ${path} did not answer within ${deadlineMs}ms`)
    this.name = 'TimeoutError'
    this.method = method
    this.path = path
    this.deadlineMs = deadlineMs
  }
}

/** DNS, TLS, a socket reset — the request never got an answer. */
export class TransportError extends CloudsForgeError {
  readonly method: string
  readonly path: string
  override readonly cause: unknown

  constructor(method: string, path: string, cause: unknown) {
    super(`${method} ${path} failed before an answer: ${describe(cause)}`)
    this.name = 'TransportError'
    this.method = method
    this.path = path
    this.cause = cause
  }
}

/** A credential could not be obtained. Raised by the credential, never by the transport. */
export class AuthError extends CloudsForgeError {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * The caller asked for something the SDK will not send — a negative amount, a missing path
 * parameter, an idempotency key on a route that has no idempotency.
 *
 * Thrown before any I/O, deliberately: a request that cannot succeed should cost nothing and
 * should not appear in the peer's logs as a 400 the peer had to reason about.
 */
export class UsageError extends CloudsForgeError {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * Parse a service error body into `{ code, message, requestId }`.
 *
 * Tolerant on purpose. A 502 from the gateway is an HTML page and a 413 may be empty; neither is
 * a reason to throw a JSON parse error over the top of the real failure and lose the status.
 */
export function parseErrorBody(text: string): ApiErrorBody {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      const error = (parsed as { error: unknown }).error
      if (error !== null && typeof error === 'object') {
        const record = error as Record<string, unknown>
        return {
          code: typeof record['code'] === 'string' ? record['code'] : 'unknown',
          message: typeof record['message'] === 'string' ? record['message'] : text.slice(0, 200),
          ...(typeof record['requestId'] === 'string' ? { requestId: record['requestId'] } : {}),
        }
      }
    }
  } catch {
    // Not JSON. Fall through: the status and the first line of the body are still the truth.
  }
  const firstLine = text.split('\n', 1)[0] ?? ''
  return { code: 'unknown', message: firstLine.slice(0, 200) || 'the peer sent no error body' }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
