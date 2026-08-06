# @cloudsforge/sdk

A typed client for the CloudsForge public API. Zero runtime dependencies, ESM, Node ≥22.

```bash
pnpm add @cloudsforge/sdk
```

```ts
import { CloudsForge, apiKey, formatAmount, decimalsFor } from '@cloudsforge/sdk'

const cf = new CloudsForge({
  baseUrl: 'https://api.cloudsforge.online',
  credential: apiKey(process.env.CLOUDSFORGE_API_KEY!),
})

const board = await cf.pricing.rates()      // public — no credential needed
const listings = await cf.market.listings() // public
const portfolio = await cf.portfolio.get()  // needs a credential

for (const balance of portfolio.balances) {
  console.log(balance.assetCode, formatAmount(balance.amount, decimalsFor(balance.assetCode)))
}
```

---

## Money is a `bigint`

Every amount in this SDK is a `bigint` in the asset's smallest unit. It goes onto the wire as a
decimal string and comes back as one, and the SDK converts in both directions so you never see a
field typed `string` that is secretly a quantity.

This is not fastidiousness. One EMBER is 10<sup>18</sup> smallest units, so a JS `number` stops
being the value you meant at about 0.009 EMBER. A float anywhere near an amount is a defect.

```ts
await cf.money.transfer({ toUserId, assetCode: 'SHARD', amount: 2_500n })
formatAmount(12345678901234567891234n, 18) // '12345.678901234567891234'
parseAmount('0.5', decimalsFor('BTC'))     // 50000000n
```

`parseAmount` refuses more fractional digits than the asset has rather than rounding — rounding
there spends somebody else's money without asking.

---

## Idempotency

Four wallet money routes and five market mutations **refuse a request without an
`Idempotency-Key`**. The SDK derives one from the route and the request body, so:

- every attempt at one operation carries **one** key — a retry is a replay, not a second debit;
- fields that legitimately change per attempt (`correlationId`) are **excluded** from the
  derivation, because a key that changed with the trace id would make every correct retry a new
  operation;
- two operations with genuinely identical bodies need distinct keys. Pass `idempotencyKey`:

```ts
await cf.money.transfer(payout, { idempotencyKey: 'payout-2026-07-31-a' })
await cf.money.transfer(payout, { idempotencyKey: 'payout-2026-07-31-b' })
```

Every mutating response carries `replayed`, so you can tell "I did this" from "this was already
done" without comparing bodies.

---

## Retries, deadlines and errors

- **A 4xx is never retried.** The peer decided; the same request gets the same answer. The
  exceptions are 408, 425 and 429, which mean *later* rather than *no*.
- **A deadline is absolute**, not per attempt. `deadlineMs` is a real ceiling on wall-clock time
  including every retry and every backoff.
- **A POST is retried only because it carries an idempotency key.** Nothing else makes it safe.
- **`Retry-After` overrides the backoff.** The peer knows better than the formula.
- **A redirect is refused, never followed** — following one would re-send your credential to
  whatever host the `Location` named.

Errors carry the request id:

```ts
try {
  await cf.withdrawals.request({ assetCode: 'BTC', destination, amount: 100_000n })
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.code, err.requestId) // the only string worth quoting at support
    if (err.isIdempotencyConflict) { /* your retry reused a key with a changed body */ }
  }
}
```

`ApiError`, `TimeoutError`, `TransportError`, `AuthError` and `UsageError` all extend
`CloudsForgeError`. A `UsageError` is thrown before any I/O — a request that cannot succeed costs
nothing and never reaches the platform as a 400 somebody has to reason about.

---

## Authentication

`Credential` is anything that can produce a bearer token on demand.

| Constructor | Use |
| --- | --- |
| `apiKey(key)` | A developer-platform API key |
| `bearerToken(token)` | A token you obtained some other way |
| `clientCredentials({ tokenUrl, clientId, clientSecret, scopes })` | OAuth 2.0 client credentials, RFC 6749 §4.4 |
| `anonymous()` | The default. Public routes only |

`clientCredentials` caches until expiry with a margin, shares one refresh across concurrent
callers, puts the secret in the form body (never a URL), and never echoes a token-endpoint body
into an error — that body can contain your secret.

**`tokenUrl` has no default, and that is deliberate.** The developer platform that will issue these
credentials is not built yet. A default here would be a URL this SDK invented, and a made-up
endpoint is worse than a required argument. When it ships, `tokenUrl` gains a default and nothing
else about this changes.

There is deliberately **no password grant** and no wrapper around the sign-in route. A third-party
application must never collect a CloudsForge password.

---

## The dependency decision, and why

**This package has zero runtime dependencies, duplicates the handful of chain constants it needs,
and checks that copy against its source in CI.**

The constraint that forces the decision: this is the only *public* repository in the programme.
Every service in the estate consumes the shared contract packages through a workspace or `link:`
dependency on a private repository. A published package cannot — `pnpm install @cloudsforge/sdk`
has to work for somebody with access to nothing of ours, and a package that depends on a repository
nobody can fetch is not a published package.

Three options, and why two were rejected:

| Option | Verdict |
| --- | --- |
| **Generate from the OpenAPI description** | The contract strategy names this as the eventual mechanism. **There is no committed OpenAPI description anywhere in the estate today** — checked, not assumed. Generating from it now would mean generating from nothing. |
| **Vendor the contract packages wholesale** | They carry internal surface: service-token claims, actor vocabularies, operator shapes. Publishing them breaks the one rule this repository exists to hold. |
| **Duplicate the narrow set of values actually needed, and check the copy** | **Chosen.** |

What is duplicated is deliberately small: asset codes, decimals, confirmation depths, `RATE_SCALE`
and `SHARDS_PER_USD` — the values you need to render an amount and to know when a deposit is final.
Not the arithmetic that decides credits; that belongs to the platform, and an SDK that reimplemented
it would invite you to compute a credit we disagree with.

Duplication is only defensible with a check, because the upstream is the one package the estate
already **exact-pins** rather than caret-ranges: a skew in a confirmation depth is not a 500, it is
money credited at the wrong depth. So `pnpm drift` reads the real upstream source and fails on any
disagreement, and CI runs it against a sibling checkout on every push.

`pnpm drift` is a script rather than a test on purpose: `pnpm test` must pass for somebody holding
only the tarball, and they have no upstream to compare against. A test that could only skip is an
unmeasured test. The values themselves are asserted by `chain.test.ts`, which runs everywhere.

---

## Routes: what this SDK calls, and where each was verified

Every request is defined once, in `ROUTES`, with the exact `path:line` in the owning service where
the route is registered. Nothing else in the SDK constructs a path.

```ts
import { ROUTES, ROUTE_NAMES } from '@cloudsforge/sdk'
ROUTES['market.listings']
// { method: 'GET', path: '/v1/listings', service: 'market', auth: 'none',
//   idempotency: 'none', verifiedAt: 'market/src/server.ts' }
```

Or from the CLI: `cloudsforge routes`.

`auth: 'none'` means the handler makes no authentication call at all, and **the SDK sends no
`Authorization` header there**. That is not an optimisation. A client that demanded a token on
public marketplace reads is what once made every listing return 403 to a signed-out browser.

---

## What is stable

Version `0.1.0`. `0.x` is the honest range while the public API itself is unreleased: `1.0.0` would
promise stability nothing has earned yet.

Within `0.x`, treated as **stable** — a change is breaking, gets a minor bump and a note:

- the `CloudsForge` client and its twelve resource groups;
- money semantics: `bigint` in, decimal string on the wire, `formatAmount`/`parseAmount`;
- error classes and `ApiError.requestId`, `.code`, `.status`, `.peerDecided`;
- credential constructors and the `Credential` interface;
- idempotency: derived keys, and `correlationId` excluded from the derivation;
- retry and deadline semantics as described above.

Treated as **unstable**, and expected to move:

- `ROUTES` entries, if the gateway mount point for the public API changes (see below);
- response fields the platform has not yet frozen — worlds provisions, market risk indicators and
  the foresight provenance block are typed loosely on purpose rather than typed wrongly;
- `clientCredentials`, until the developer platform exists and the token endpoint has a default.

Removing or narrowing an export from the entry point is a breaking change, and CI proves the repo
did not make one: the estate's contract-compatibility checker diffs the exported **type surface**
against the base ref and fails on a removed field, a narrowed type or a renamed key, and
`index.test.ts` pins the exported **value** surface as a list that has to be edited deliberately.

---

## What this API does not offer

Stated because a method that 404s is worse than an absent one — it sends you to support instead of
to the documentation.

- **The ledger.** Every route on the double-entry ledger requires a *service* token; the handler
  refuses a user principal outright. Journal entries, reservations, the trial balance and
  reconciliation are unreachable to a third party, and there is no method for any of them.
- **Operator surfaces.** Moderation cases, dispute resolution, verification writes, market
  approval/deployment/resolution, the idea queue, administered prices, signing keys and the
  estate-wide activity feed are all operator- or admin-gated. Absent, deliberately.
- **Event intake.** The platform's event endpoints are HMAC-signed intakes for its own relay. They
  are not a place a third party posts.
- **Webhooks, API-key management, quotas and usage.** These belong to the developer platform, which
  does not exist yet. When it does, they arrive here additively.
- **Sign-in, registration, password and MFA.** They exist; they are not this SDK's to offer.
  `identity.me()` is the one identity call included, and it **requires a user token** — a machine
  credential gets 403 there, by design, and no route answers the same question for one.
- **An on-chain balance.** `portfolio.wallets[].balance` is always `null`, and the field next to it
  says why: the platform's indexer exposes no balance read. `netObserved` is confirmed-in minus
  confirmed-out over the window that read saw — useful for "has anything happened here", useless
  for "how much is there", and named so the difference is hard to miss.
- **Auto-pagination.** Every paged read hands back the page and its cursor. An iterator that hid how
  many requests it made would hide the number you are billed and rate-limited on.

### One thing to know about `baseUrl`

The public API is `https://api.cloudsforge.online/v1`, and **the gateway's path mapping now
exists** — measured 2026-08-05, `/v1/rates` and `/v1/titles` both answer `200 application/json`.
The paths in `ROUTES` are the services' own paths, which is what a reverse proxy without rewriting
produces, so the default works as shipped.

Two things worth knowing about that host:

- **Only `/v1/…` is routed.** An unmatched path such as `/` or `/livez` answers `502` rather than
  `404` — a known defect being corrected to `404`, not a sign the API is down. Every `/v1` route
  works.
- **`api.<apex>` serves no HTML.** It is `servesUi: false` in
  `ui/packages/ui/src/surfaces.ts`; do not link a person to it.

For testnet, use `https://api-testnet.cloudsforge.online` — testnet hostnames are single-label
`<surface>-testnet.cloudsforge.online`, never `<surface>.testnet.cloudsforge.online`.

If you mount the routes under a different prefix, set `pathPrefix` and nothing else changes:

```ts
new CloudsForge({ baseUrl: 'https://api.cloudsforge.online', pathPrefix: '/v1' })
```

---

## Licence

MIT.
