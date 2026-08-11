/**
 * `cloudsforge` — the public CLI.
 *
 * ## Why it is not `cfctl`
 *
 * The estate has an internal `cfctl` that scaffolds services, reads the registry and talks to
 * operator surfaces. This is a different tool with a different audience, and giving them the same
 * name would put an operator one `$PATH` entry away from running the wrong one. The binary is
 * `cloudsforge`.
 *
 * ## Why every command is read-only
 *
 * Deliberate, and the one design decision here worth arguing about. The SDK can spend, transfer,
 * convert and withdraw; the CLI cannot. A shell is where a typo, a stale history entry or a
 * mis-expanded variable turns into a request, and the three routes that move money are exactly
 * where that must not happen. "Enough to be useful and no more" is authenticate, list and inspect —
 * and `--json` so a script can do the rest through the SDK, deliberately, in a file somebody
 * reviewed.
 *
 * ## Composability
 *
 * `--json` prints the decoded object with every bigint as a decimal string. Exit codes are in
 * `exit.ts` and mean something, so a pipeline can branch without parsing English.
 */

import {
  ApiError,
  CloudsForge,
  ROUTES,
  ROUTE_NAMES,
  TimeoutError,
  TransportError,
  UsageError,
  anonymous,
  apiKey,
  bearerToken,
  clientCredentials,
  decimalsFor,
  formatAmount,
  isAssetCode,
  type Credential,
} from '@cloudsforge/sdk'
import { UsageProblem, boolFlag, numberFlag, parse, stringFlag, type Parsed } from './args.ts'
import { EXIT, type ExitCode } from './exit.ts'
import { details, orDash, table, toJson } from './render.ts'

export const CLI_VERSION = '0.1.0'

export interface Io {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * The network, injected.
   *
   * A CLI's I/O is stdout, stderr, the environment AND the network; treating the last one as
   * ambient is what forces a test suite to spawn a process or monkey-patch a global. Every test in
   * `run.test.ts` drives the real command dispatch instead.
   */
  readonly fetch?: typeof globalThis.fetch
}

const HELP = `cloudsforge — the CloudsForge public API, from a shell

USAGE
  cloudsforge <command> [options]

COMMANDS
  auth status                  Resolve the credential and say who it belongs to
  routes                       Every route this CLI and the SDK can call, and where each was verified
  rates [--asset CODE]         The rate board, or one asset's rate            (public)
  listings [--status S]        Marketplace listings                           (public)
  listing <id>                 One listing, with its royalties               (public)
  markets [--status S]         Prediction markets                            (public)
  market <id>                  One market, with its pool and its document    (public)
  titles                       Registered game titles                        (public)
  catalogue                    What the token mint will deploy               (public)
  portfolio                    Balances and observed wallets
  wallets                      Your wallets
  deposits                     Deposit addresses
  credits                      Credited deposits
  withdrawals                  Withdrawals
  orders [--role buyer|seller] Marketplace orders
  tokens                       Tokens you have minted
  activity [--category C]      Your activity feed

OPTIONS
  --base-url URL      The API origin. Default: $CLOUDSFORGE_BASE_URL
  --api-key KEY       Default: $CLOUDSFORGE_API_KEY
  --token TOKEN       A bearer token you already hold. Default: $CLOUDSFORGE_TOKEN
  --token-url URL     OAuth token endpoint, with --client-id and --client-secret
  --client-id ID      Default: $CLOUDSFORGE_CLIENT_ID
  --client-secret S   Default: $CLOUDSFORGE_CLIENT_SECRET  (prefer the variable to the flag)
  --scope "a b"       Space-delimited OAuth scopes
  --path-prefix P     Prefix every route path. See the SDK README on the gateway mapping.
  --deadline MS       Wall-clock ceiling for the whole call, retries included
  --limit N  --cursor C  --status S  --asset CODE  --category C  --product P  --role R  --title ID
  --include-retired   Include retired wallets
  --json              Machine-readable output; every amount is a decimal string
  -h, --help          This
  -v, --version       Print the version

EXIT CODES
  0 ok   2 usage   3 auth   4 not found   5 refused   6 unavailable   7 timeout   1 other

NOTE
  Every command here is READ-ONLY. Spending, transferring, converting and withdrawing are in the
  SDK and not in this CLI: a shell is where a typo becomes a request, and those are the four
  requests that must never be made by accident.

  A secret on a command line is visible in your shell history and in \`ps\`. Prefer the environment
  variables.
`

/* ------------------------------------------------------------------ entry point */

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  let parsed: Parsed
  try {
    parsed = parse(argv)
  } catch (err) {
    io.err(message(err))
    return EXIT.USAGE
  }

  if (boolFlag(parsed, 'version')) {
    io.out(CLI_VERSION)
    return EXIT.OK
  }
  if (boolFlag(parsed, 'help') || parsed.words.length === 0) {
    io.out(HELP)
    return parsed.words.length === 0 && !boolFlag(parsed, 'help') ? EXIT.USAGE : EXIT.OK
  }

  try {
    return await dispatch(parsed, io)
  } catch (err) {
    io.err(message(err))
    return codeFor(err)
  }
}

async function dispatch(parsed: Parsed, io: Io): Promise<ExitCode> {
  const json = boolFlag(parsed, 'json')
  const [command, ...rest] = parsed.words

  // `routes` needs no client and no network: it is the answer to "what can this thing even call",
  // and needing a base URL to ask that would be absurd.
  if (command === 'routes') {
    const rows = ROUTE_NAMES.map((name) => ({ name, ...ROUTES[name] }))
    io.out(
      json
        ? toJson(rows)
        : table(rows, [
            { heading: 'name', of: (row) => row.name },
            { heading: 'method', of: (row) => row.method },
            { heading: 'path', of: (row) => row.path },
            { heading: 'auth', of: (row) => row.auth },
            { heading: 'idempotency', of: (row) => row.idempotency },
            { heading: 'verified at', of: (row) => row.verifiedAt },
          ]),
    )
    return EXIT.OK
  }

  const cf = clientFrom(parsed, io)

  switch (command) {
    case 'auth': {
      if (rest[0] !== undefined && rest[0] !== 'status') {
        throw new UsageProblem(`unknown subcommand: auth ${rest[0]}`)
      }
      const me = await cf.identity.me()
      io.out(
        json
          ? toJson(me)
          : details([
              ['user', me.user.id],
              ['handle', me.user.handle],
              ['status', me.user.status],
              ['session', me.session.id],
              ['organisations', me.organisations.map((org) => org.slug).join(', ') || '(none)'],
            ]),
      )
      return EXIT.OK
    }

    case 'rates': {
      const asset = stringFlag(parsed, 'asset')
      if (asset !== undefined) {
        const upper = asset.toUpperCase()
        if (!isAssetCode(upper)) throw new UsageProblem(`not a known asset: ${asset}`)
        const rate = await cf.pricing.rate(upper)
        io.out(json ? toJson(rate) : details(ratePairs(rate)))
        return EXIT.OK
      }
      const board = await cf.pricing.rates()
      io.out(
        json
          ? toJson(board)
          : table([...board.rates], [
              { heading: 'asset', of: (row) => row.asset },
              { heading: 'usable', of: (row) => String(row.usable) },
              { heading: 'usd', of: (row) => orDash(row.usd), numeric: true },
              { heading: 'quoted at', of: (row) => orDash(row.quotedAt) },
              // The reason an asset is unusable is the point of listing it at all.
              { heading: 'reason', of: (row) => orDash(row.reason) },
            ]),
      )
      return EXIT.OK
    }

    case 'listings': {
      const listings = await cf.market.listings({
        ...optional('status', stringFlag(parsed, 'status')),
      })
      io.out(
        json
          ? toJson(listings)
          : table([...listings], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'kind', of: (row) => row.assetKind },
              { heading: 'item', of: (row) => row.itemUrn },
              { heading: 'price', of: (row) => (row.price === null ? '-' : row.price.toString()), numeric: true },
              { heading: 'asset', of: (row) => row.assetCode },
              { heading: 'status', of: (row) => row.status },
            ]),
      )
      return EXIT.OK
    }

    case 'listing': {
      const id = required(rest[0], 'listing <id>')
      const result = await cf.market.listing(id)
      io.out(
        json
          ? toJson(result)
          : details([
              ['id', result.listing.id],
              ['seller', result.listing.sellerSubject],
              ['item', result.listing.itemUrn],
              ['quantity', result.listing.quantity.toString()],
              ['price', result.listing.price === null ? '-' : result.listing.price.toString()],
              ['asset', result.listing.assetCode],
              ['settlement', result.listing.settlementMode],
              ['status', result.listing.status],
              ['frozen', String(result.listing.frozen)],
              ['escrowed', String(result.listing.escrowed)],
              ['royalties', result.royalties.map((r) => `${r.subject}=${r.bps}bps`).join(', ') || '(none)'],
            ]),
      )
      return EXIT.OK
    }

    case 'markets': {
      const markets = await cf.foresight.markets({
        ...optional('status', stringFlag(parsed, 'status')),
        ...optional('limit', numberFlag(parsed, 'limit')),
      })
      io.out(
        json
          ? toJson(markets)
          : table([...markets], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'status', of: (row) => row.status },
              { heading: 'closes', of: (row) => row.closeTime },
              { heading: 'question', of: (row) => row.question.slice(0, 60) },
            ]),
      )
      return EXIT.OK
    }

    case 'market': {
      const id = required(rest[0], 'market <id>')
      const detail = await cf.foresight.market(id)
      io.out(
        json
          ? toJson(detail)
          : details([
              ['id', detail.market.id],
              ['question', detail.market.question],
              ['status', detail.market.status],
              ['closes', detail.market.closeTime],
              ['yes', detail.pool.yes.toString()],
              ['no', detail.pool.no.toString()],
              ['stakers', String(detail.pool.stakerCount)],
              // Never printed without them: a pool with no as-of reads as live.
              ['as of', orDash(detail.pool.asOf)],
              ['stale', String(detail.pool.stale)],
              ['question hash', detail.market.questionHash],
            ]),
      )
      return EXIT.OK
    }

    case 'titles': {
      const titles = await cf.worlds.titles()
      io.out(
        json
          ? toJson(titles)
          : table([...titles], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'slug', of: (row) => row.slug },
              { heading: 'name', of: (row) => row.name },
              { heading: 'status', of: (row) => row.status },
            ]),
      )
      return EXIT.OK
    }

    case 'catalogue': {
      const catalogue = await cf.mint.catalogue()
      io.out(
        json
          ? toJson(catalogue)
          : `${details([
              // The label states the unit the SERVER sends, and the value is that number
              // unconverted. It read 'price (shards)' until mint retired SHARD and re-based the
              // field to US cents — at which point the figure printed was cents and the word
              // beside it named an asset the estate no longer issues. Converting to dollars here
              // would put arithmetic between the operator and the quote; the cents are what the
              // catalogue said, so the cents are what is printed.
              ['price (USD cents)', catalogue.priceUsdCents.toString()],
              ['network', catalogue.network],
            ])}\n\n${table([...catalogue.variants], [
              { heading: 'variant', of: (row) => row.variant },
              { heading: 'contract', of: (row) => row.contract },
              { heading: 'features', of: (row) => row.features.join(',') || '-' },
            ])}`,
      )
      return EXIT.OK
    }

    case 'portfolio': {
      const portfolio = await cf.portfolio.get({ ...optional('limit', numberFlag(parsed, 'limit')) })
      if (json) {
        io.out(toJson(portfolio))
        return EXIT.OK
      }
      const balances = table([...portfolio.balances], [
        { heading: 'asset', of: (row) => row.assetCode },
        { heading: 'purpose', of: (row) => row.purpose },
        { heading: 'amount', of: (row) => amount(row.assetCode, row.amount), numeric: true },
        { heading: 'usd', of: (row) => (row.valuation === null ? '-' : formatAmount(row.valuation.usdScaled, 6)), numeric: true },
        { heading: 'quoted at', of: (row) => (row.valuation === null ? '-' : row.valuation.quotedAt) },
      ])
      // Degraded is printed even when empty. "We could not reach the indexer" and "there is
      // nothing on chain" must never look the same.
      io.out(
        `${balances}\n\nas of      ${portfolio.asOf}\ndegraded   ${portfolio.degraded.join(', ') || '(nothing)'}`,
      )
      return EXIT.OK
    }

    case 'wallets': {
      const page = await cf.wallets.list({
        ...optional('limit', numberFlag(parsed, 'limit')),
        ...optional('cursor', stringFlag(parsed, 'cursor')),
        ...(boolFlag(parsed, 'include-retired') ? { includeRetired: true } : {}),
      })
      io.out(
        json
          ? toJson(page)
          : table([...page.wallets], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'chain', of: (row) => row.chain },
              { heading: 'origin', of: (row) => row.origin },
              { heading: 'address', of: (row) => row.address },
              { heading: 'status', of: (row) => row.status },
              { heading: 'label', of: (row) => orDash(row.label) },
            ]),
      )
      return EXIT.OK
    }

    case 'deposits': {
      const result = await cf.deposits.list()
      io.out(
        json
          ? toJson(result)
          : table([...result.assignments], [
              { heading: 'asset', of: (row) => row.assetCode },
              { heading: 'address', of: (row) => row.address },
              { heading: 'status', of: (row) => row.status },
              // An unwatched address produces no events, so this is the field that explains a
              // deposit that "did not arrive".
              { heading: 'watched at', of: (row) => orDash(row.watchedAt) },
            ]),
      )
      return EXIT.OK
    }

    case 'credits': {
      const page = await cf.deposits.credits({
        ...optional('limit', numberFlag(parsed, 'limit')),
        ...optional('cursor', stringFlag(parsed, 'cursor')),
      })
      io.out(
        json
          ? toJson(page)
          : table([...page.credits], [
              { heading: 'asset', of: (row) => row.assetCode },
              { heading: 'amount', of: (row) => row.amountFormatted, numeric: true },
              { heading: 'confirmations', of: (row) => String(row.confirmations), numeric: true },
              // Not the same question as "did it arrive". A row exists before the posting lands.
              { heading: 'credited', of: (row) => String(row.credited) },
              { heading: 'tx', of: (row) => row.txHash },
            ]),
      )
      return EXIT.OK
    }

    case 'withdrawals': {
      const page = await cf.withdrawals.list({
        ...optional('limit', numberFlag(parsed, 'limit')),
        ...optional('cursor', stringFlag(parsed, 'cursor')),
      })
      io.out(
        json
          ? toJson(page)
          : table([...page.withdrawals], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'asset', of: (row) => row.assetCode },
              { heading: 'amount', of: (row) => row.amountFormatted, numeric: true },
              { heading: 'state', of: (row) => row.state },
              { heading: 'tx', of: (row) => orDash(row.txHash) },
              { heading: 'reason', of: (row) => orDash(row.failureReason) },
            ]),
      )
      return EXIT.OK
    }

    case 'orders': {
      const role = stringFlag(parsed, 'role')
      if (role !== undefined && role !== 'buyer' && role !== 'seller') {
        throw new UsageProblem('--role must be buyer or seller')
      }
      const orders = await cf.market.orders({ ...optional('role', role) })
      io.out(
        json
          ? toJson(orders)
          : table([...orders], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'item', of: (row) => row.itemUrn },
              { heading: 'amount', of: (row) => row.amount.toString(), numeric: true },
              { heading: 'asset', of: (row) => row.assetCode },
              { heading: 'proceeds', of: (row) => row.proceedsState },
              { heading: 'settled at', of: (row) => row.settledAt },
            ]),
      )
      return EXIT.OK
    }

    case 'tokens': {
      const tokens = await cf.mint.tokens()
      io.out(
        json
          ? toJson(tokens)
          : table([...tokens], [
              { heading: 'id', of: (row) => row.id },
              { heading: 'symbol', of: (row) => row.symbol },
              { heading: 'chain', of: (row) => row.chain },
              { heading: 'status', of: (row) => row.status },
              { heading: 'contract', of: (row) => orDash(row.contractAddress) },
            ]),
      )
      return EXIT.OK
    }

    case 'activity': {
      const page = await cf.activity.feed({
        ...optional('limit', numberFlag(parsed, 'limit')),
        ...optional('cursor', stringFlag(parsed, 'cursor')),
        ...optional('category', stringFlag(parsed, 'category') as never),
        ...optional('product', stringFlag(parsed, 'product')),
      })
      io.out(
        json
          ? toJson(page)
          : table([...page.records], [
              { heading: 'occurred at', of: (row) => row.occurredAt },
              { heading: 'category', of: (row) => row.category },
              { heading: 'summary', of: (row) => row.summary },
              { heading: 'amount', of: (row) => (row.amount === null ? '-' : row.amount.toString()), numeric: true },
              // The id to quote at support, on every row.
              { heading: 'correlation', of: (row) => orDash(row.correlationId) },
            ]),
      )
      return EXIT.OK
    }

    default:
      throw new UsageProblem(`unknown command: ${String(command)}\n\nRun 'cloudsforge --help'.`)
  }
}

/* ------------------------------------------------------------------ wiring */

function clientFrom(parsed: Parsed, io: Io): CloudsForge {
  const baseUrl = stringFlag(parsed, 'base-url') ?? io.env['CLOUDSFORGE_BASE_URL']
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new UsageProblem(
      'no API base URL: pass --base-url or set CLOUDSFORGE_BASE_URL.\n' +
        'There is no default, deliberately — a wrong default sends your credential to a host you ' +
        'did not choose.',
    )
  }
  const deadline = numberFlag(parsed, 'deadline')
  return new CloudsForge({
    baseUrl,
    credential: credentialFrom(parsed, io),
    ...optional('pathPrefix', stringFlag(parsed, 'path-prefix')),
    ...optional('deadlineMs', deadline),
    ...optional('fetch', io.fetch),
    userAgent: `cloudsforge-cli/${CLI_VERSION}`,
  })
}

/**
 * The credential, resolved in a stated order.
 *
 * An explicit flag beats the environment; a bearer token beats an API key; client credentials are
 * used only when the token endpoint is given, because there is no default for it — see the SDK's
 * `credentials.ts` for why. (devplatform ships and mints API keys; what it deliberately does not
 * have is a token endpoint, because signing a token is identity's to do. A made-up URL is still
 * worse than none. Set `CLOUDSFORGE_API_KEY` instead.)
 */
export function credentialFrom(parsed: Parsed, io: Io): Credential {
  const tokenUrl = stringFlag(parsed, 'token-url') ?? io.env['CLOUDSFORGE_TOKEN_URL']
  const clientId = stringFlag(parsed, 'client-id') ?? io.env['CLOUDSFORGE_CLIENT_ID']
  const clientSecret = stringFlag(parsed, 'client-secret') ?? io.env['CLOUDSFORGE_CLIENT_SECRET']
  if (tokenUrl && clientId && clientSecret) {
    const scope = stringFlag(parsed, 'scope')
    return clientCredentials({
      tokenUrl,
      clientId,
      clientSecret,
      ...(scope ? { scopes: scope.split(/\s+/).filter(Boolean) } : {}),
    })
  }
  const token = stringFlag(parsed, 'token') ?? io.env['CLOUDSFORGE_TOKEN']
  if (token) return bearerToken(token)
  const key = stringFlag(parsed, 'api-key') ?? io.env['CLOUDSFORGE_API_KEY']
  if (key) return apiKey(key)
  // Not an error: half the commands are public reads and demanding a credential for them would be
  // the 403 defect in a different costume.
  return anonymous()
}

/* ------------------------------------------------------------------ presentation helpers */

function ratePairs(rate: {
  asset: string
  usable: boolean
  reason?: string
  usd: string | null
  usdSell: string | null
  usdBuy: string | null
  quotedAt: string | null
  ageSeconds: number | null
  lastFailure: string | null
}): readonly (readonly [string, string])[] {
  return [
    ['asset', rate.asset],
    ['usable', String(rate.usable)],
    ['reason', orDash(rate.reason)],
    ['usd (mid)', orDash(rate.usd)],
    ['usd (you sell)', orDash(rate.usdSell)],
    ['usd (you buy)', orDash(rate.usdBuy)],
    ['quoted at', orDash(rate.quotedAt)],
    ['age (s)', rate.ageSeconds === null ? '-' : String(rate.ageSeconds)],
    ['last failure', orDash(rate.lastFailure)],
  ]
}

/** Render a balance at the asset's own scale when we know it, and exactly when we do not. */
function amount(assetCode: string, units: bigint): string {
  return isAssetCode(assetCode) ? formatAmount(units, decimalsFor(assetCode)) : units.toString()
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageProblem(`usage: cloudsforge ${usage}`)
  return value
}

/* ------------------------------------------------------------------ failure */

export function codeFor(err: unknown): ExitCode {
  if (err instanceof UsageProblem || err instanceof UsageError) return EXIT.USAGE
  if (err instanceof TimeoutError) return EXIT.TIMEOUT
  if (err instanceof TransportError) return EXIT.UNAVAILABLE
  if (err instanceof ApiError) {
    if (err.isUnauthenticated || err.isForbidden) return EXIT.AUTH
    if (err.isNotFound) return EXIT.NOT_FOUND
    return err.peerDecided ? EXIT.REFUSED : EXIT.UNAVAILABLE
  }
  return EXIT.FAILURE
}

/**
 * What the user sees on stderr.
 *
 * An `ApiError` prints its request id, always. It is the only string a developer can quote at
 * support, and a CLI that dropped it would send every one of them into a conversation that starts
 * with "can you reproduce it".
 */
export function message(err: unknown): string {
  if (err instanceof ApiError) {
    const id = err.requestId ? `\nrequest id: ${err.requestId}` : ''
    const hint = err.isUnauthenticated
      ? '\nhint: set CLOUDSFORGE_API_KEY, or pass --token.'
      : err.isForbidden
        ? '\nhint: the credential was understood and refused. Re-authenticating will not help.'
        : ''
    return `error: ${err.code}: ${err.message.split(': ').slice(1).join(': ') || err.message}${id}${hint}`
  }
  if (err instanceof Error) return `error: ${err.message}`
  return `error: ${String(err)}`
}
