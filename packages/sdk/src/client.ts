/**
 * `CloudsForge` — the client, and the only object most callers construct.
 *
 * ## The shape
 *
 * One client, one credential, one deadline policy; resources hanging off it as plain objects. A
 * resource method does three things and no more: name a route from `ROUTES`, pass parameters, and
 * decode the answer. There is no method here that is not backed by a route in that table, and
 * `routes.test.ts` proves it by walking this object.
 *
 * ## What it does not do
 *
 * - **It does not validate response shapes.** Additive change is the public API's promise
 *   (`11-data-and-contract-strategy.md:307`); a client that rejected an unrecognised field would
 *   turn every additive change into an outage for everyone who had not upgraded.
 * - **It does not paginate for you.** Every paged read returns the page and its cursor. An
 *   auto-paginating iterator hides how many requests it made, which is the number a developer is
 *   billed on and rate-limited by.
 * - **It does not retry a 4xx**, ever, and it does not retry a POST without an idempotency key.
 *   See `transport.ts`.
 */

import { anonymous, type Credential } from './credentials.ts'
import {
  decodeActivityRecord,
  decodeAchievement,
  decodeBid,
  decodeCatalogue,
  decodeDepositCredit,
  decodeListing,
  decodeOffer,
  decodeOrder,
  decodePool,
  decodePortfolio,
  decodePosition,
  decodeRate,
  decodeRateBoard,
  decodeToken,
  decodeWithdrawal,
} from './decode.ts'
import { UsageError } from './errors.ts'
import { amountToWire } from './money.ts'
import { ROUTES, type RouteName } from './routes.ts'
import { Transport, type CallOptions, type TransportOptions } from './transport.ts'
import type {
  Achievement,
  ActivityCategory,
  ActivityRecord,
  Bid,
  Collection,
  DepositAssignment,
  DepositCredit,
  DeployAccepted,
  DeployAttempt,
  Dispute,
  InventoryItem,
  Listing,
  ListingRisk,
  MarketDetail,
  MarketPosition,
  Me,
  MintCatalogue,
  MoneyResult,
  Offer,
  Order,
  Player,
  PlayerProfile,
  Portfolio,
  PredictionMarket,
  Rate,
  RateBoard,
  StakeIntent,
  Title,
  Token,
  Wallet,
  WalletChallenge,
  WalletLink,
  WalletOrigin,
  WalletStatus,
  Withdrawal,
} from './types.ts'
import type { AssetCode } from './chain.ts'

export interface CloudsForgeOptions extends Omit<TransportOptions, 'credential'> {
  readonly credential?: Credential
}

/** Options every call accepts, without the ones the resource method owns. */
export type Options = Pick<
  CallOptions,
  'deadlineMs' | 'retries' | 'signal' | 'idempotencyKey' | 'traceparent'
>

type Raw = Readonly<Record<string, unknown>>

/* ------------------------------------------------------------------ request shapes */

export interface ListWalletsQuery {
  readonly limit?: number
  readonly cursor?: string
  readonly origin?: WalletOrigin
  /** Retired wallets are hidden by default; an explicit ask includes them. */
  readonly includeRetired?: boolean
}

export interface RegisterWalletRequest {
  readonly chain: string
  readonly address: string
  /**
   * `external` issues a challenge to sign; `watch` does not.
   *
   * `managed` is refused by the service (`wallet/src/server.ts:472`) and is therefore not in this
   * type: a managed wallet is created only by the deposit-assignment path, which is the one place a
   * custody key is minted.
   */
  readonly origin: 'external' | 'watch'
  readonly label?: string
  readonly statement?: string
}

export interface VerifyWalletRequest {
  readonly nonce: string
  readonly signature: string
  readonly authorisations?: readonly string[]
}

export interface UpdateWalletRequest {
  readonly label?: string | null
  readonly isPrimary?: true
  readonly status?: WalletStatus
}

export interface WithdrawRequest {
  readonly assetCode: AssetCode
  readonly destination: string
  /** Smallest units. */
  readonly amount: bigint
}

export interface SpendRequest {
  /** Shards, smallest units. */
  readonly amount: bigint
  readonly reason: string
}

export interface TransferRequest {
  readonly toUserId: string
  readonly assetCode: AssetCode
  readonly amount: bigint
}

export interface ConvertRequest {
  readonly fromAssetCode: AssetCode
  readonly toAssetCode: AssetCode
  readonly amount: bigint
}

export interface ListingsQuery {
  /** Defaults to `active` server-side; a browse that showed drafts would leak what sellers tried. */
  readonly status?: string
  readonly assetKind?: string
  readonly sellerSubject?: string
  readonly collectionId?: string
}

export interface CreateListingRequest {
  readonly assetKind: string
  readonly itemUrn: string
  readonly itemAssetCode: string
  readonly assetCode: string
  readonly pricingMode: string
  readonly settlementMode: string
  readonly price?: bigint | null
  readonly quantity?: bigint
  readonly reservePrice?: bigint | null
  readonly collectionId?: string
  readonly sellerWalletId?: string
  readonly royaltyBps?: number
  readonly auctionEndsAt?: string
  readonly expiresAt?: string
  readonly royaltyRecipients?: readonly { readonly subject: string; readonly bps: number }[]
}

export interface CreateTokenRequest {
  readonly chain: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  /** Smallest units, at `decimals`. A supply of 10^24 is ordinary and does not survive a number. */
  readonly supply: bigint
  readonly cap?: bigint | null
  readonly features?: readonly string[]
  readonly ownerAddress: string
  readonly ownerWalletId: string
  readonly network?: string
  readonly metadataUri?: string
  readonly brandKitId?: string
}

export interface FeedQuery {
  readonly limit?: number
  readonly cursor?: string
  readonly category?: ActivityCategory
  readonly product?: string
}

/* ------------------------------------------------------------------ the client */

export class CloudsForge {
  readonly #transport: Transport

  readonly pricing: PricingResource
  readonly wallets: WalletsResource
  readonly deposits: DepositsResource
  readonly withdrawals: WithdrawalsResource
  readonly money: MoneyResource
  readonly portfolio: PortfolioResource
  readonly market: MarketResource
  readonly mint: MintResource
  readonly foresight: ForesightResource
  readonly worlds: WorldsResource
  readonly activity: ActivityResource
  readonly identity: IdentityResource

  constructor(options: CloudsForgeOptions) {
    this.#transport = new Transport({ ...options, credential: options.credential ?? anonymous() })
    const call = <T>(name: RouteName, o: CallOptions = {}): Promise<T> =>
      this.#transport.call<T>(name, ROUTES[name], o)

    this.pricing = new PricingResource(call)
    this.wallets = new WalletsResource(call)
    this.deposits = new DepositsResource(call)
    this.withdrawals = new WithdrawalsResource(call)
    this.money = new MoneyResource(call)
    this.portfolio = new PortfolioResource(call)
    this.market = new MarketResource(call)
    this.mint = new MintResource(call)
    this.foresight = new ForesightResource(call)
    this.worlds = new WorldsResource(call)
    this.activity = new ActivityResource(call)
    this.identity = new IdentityResource(call)
  }
}

type Call = <T>(name: RouteName, options?: CallOptions) => Promise<T>

abstract class Resource {
  protected readonly call: Call
  constructor(call: Call) {
    this.call = call
  }
}

/* ------------------------------------------------------------------ pricing */

/** Public. No credential is needed and none is sent — the routes make no `authenticate()` call. */
class PricingResource extends Resource {
  /**
   * The whole rate board, including assets that are NOT usable.
   *
   * An unusable asset is listed with its reason rather than omitted, deliberately
   * (`pricing/src/server.ts:307`): omitting it makes a client that iterates the board silently
   * forget the asset exists, which is how a deposit page loses a coin. Check `rate.usable` before
   * you use `rate.usdScaled`; it is `null` when it is not.
   */
  async rates(options: Options = {}): Promise<RateBoard> {
    return decodeRateBoard(await this.call<Raw>('pricing.rates', options))
  }

  /** 200 even when the rate is unusable — the caller asked what the rate is, and this is it. */
  async rate(asset: AssetCode, options: Options = {}): Promise<Rate> {
    const body = await this.call<{ rate: Raw }>('pricing.rate', { ...options, params: { asset } })
    return decodeRate(body.rate)
  }
}

/* ------------------------------------------------------------------ wallets */

class WalletsResource extends Resource {
  async list(query: ListWalletsQuery = {}, options: Options = {}): Promise<{ wallets: readonly Wallet[]; nextCursor: string | null }> {
    return this.call('wallet.list', { ...options, query: { ...query } })
  }

  async get(id: string, options: Options = {}): Promise<{ wallet: Wallet; link: WalletLink | null }> {
    return this.call('wallet.get', { ...options, params: { id } })
  }

  /**
   * Register an external or watch address.
   *
   * `external` leaves the wallet `provisioning` and returns a challenge to sign; `watch` does not.
   * That asymmetry is a security invariant, not a convenience: a watch wallet has no link, so it
   * holds no authorisation and can never be a withdrawal destination.
   */
  async register(request: RegisterWalletRequest, options: Options = {}): Promise<WalletChallenge & Raw> {
    return this.call('wallet.register', { ...options, body: { ...request } })
  }

  /** Submit a signature over an issued challenge. */
  async verify(request: VerifyWalletRequest, options: Options = {}): Promise<{ link: WalletLink }> {
    return this.call('wallet.verify', { ...options, body: { ...request } })
  }

  async update(id: string, request: UpdateWalletRequest, options: Options = {}): Promise<{ wallet: Wallet }> {
    return this.call('wallet.update', { ...options, params: { id }, body: { ...request } })
  }

  async grantAuthorisation(id: string, authorisation: string, options: Options = {}): Promise<{ link: WalletLink }> {
    return this.call('wallet.grantAuthorisation', { ...options, params: { id }, body: { authorisation } })
  }

  /**
   * Revoke one authorisation, or pass `'all'` to disconnect the wallet entirely — every
   * authorisation and the link itself, in one transaction (`wallet/src/server.ts:586`).
   */
  async revokeAuthorisation(id: string, authorisation: string | 'all', options: Options = {}): Promise<{ link: WalletLink }> {
    return this.call('wallet.revokeAuthorisation', { ...options, params: { id, authorisation } })
  }
}

/* ------------------------------------------------------------------ deposits */

class DepositsResource extends Resource {
  /**
   * Get (or rotate) the deposit address for an asset.
   *
   * `rotate` must be an explicit ask. Defaulting to it would mint a new address on every page load
   * and leave a trail of addresses nobody was told about.
   */
  async assign(assetCode: AssetCode, request: { readonly rotate?: boolean } = {}, options: Options = {}): Promise<{ assignment: DepositAssignment }> {
    return this.call('deposits.assign', {
      ...options,
      body: { assetCode, ...(request.rotate === true ? { rotate: true } : {}) },
    })
  }

  async list(options: Options = {}): Promise<{ assignments: readonly DepositAssignment[] }> {
    return this.call('deposits.list', options)
  }

  /**
   * Credited deposits, newest first.
   *
   * `credit.credited` is the field that matters: a row exists before the ledger posting lands, and
   * showing an uncredited row as money the user has is the oldest mistake in this estate.
   */
  async credits(query: { readonly limit?: number; readonly cursor?: string } = {}, options: Options = {}): Promise<{ credits: readonly DepositCredit[]; nextCursor: string | null }> {
    const body = await this.call<{ credits: Raw[]; nextCursor: string | null }>('deposits.credits', {
      ...options,
      query: { ...query },
    })
    return { credits: body.credits.map(decodeDepositCredit), nextCursor: body.nextCursor }
  }
}

/* ------------------------------------------------------------------ withdrawals */

class WithdrawalsResource extends Resource {
  /**
   * Request a withdrawal. **The service refuses this without an idempotency key.**
   *
   * One is derived from the request by default, so a retry of the same withdrawal is a replay
   * rather than a second withdrawal. Two genuinely separate withdrawals of the same amount to the
   * same address need distinct keys — pass `idempotencyKey` for the second.
   *
   * `result.replayed` distinguishes "I did this" from "this was already done".
   */
  async request(request: WithdrawRequest, options: Options = {}): Promise<{ withdrawal: Withdrawal; replayed: boolean }> {
    requirePositive(request.amount, 'amount')
    const body = await this.call<{ withdrawal: Raw; replayed: boolean }>('withdrawals.request', {
      ...options,
      body: {
        assetCode: request.assetCode,
        destination: request.destination,
        amount: amountToWire(request.amount),
      },
    })
    return { withdrawal: decodeWithdrawal(body.withdrawal), replayed: body.replayed }
  }

  async list(query: { readonly limit?: number; readonly cursor?: string } = {}, options: Options = {}): Promise<{ withdrawals: readonly Withdrawal[]; nextCursor: string | null }> {
    const body = await this.call<{ withdrawals: Raw[]; nextCursor: string | null }>('withdrawals.list', {
      ...options,
      query: { ...query },
    })
    return { withdrawals: body.withdrawals.map(decodeWithdrawal), nextCursor: body.nextCursor }
  }

  async get(id: string, options: Options = {}): Promise<{ withdrawal: Withdrawal }> {
    const body = await this.call<{ withdrawal: Raw }>('withdrawals.get', { ...options, params: { id } })
    return { withdrawal: decodeWithdrawal(body.withdrawal) }
  }
}

/* ------------------------------------------------------------------ money */

/**
 * The three mutating money routes. Every one of them REQUIRES an idempotency key, and the SDK
 * offers no way to omit it — `wallet/src/server.ts:711` calls that the line the service exists to
 * add, because forge-pay's `/spend` accepted a missing key and a retry debited twice.
 */
class MoneyResource extends Resource {
  /** Debit Shards for something the platform provided. */
  async spend(request: SpendRequest, options: Options = {}): Promise<MoneyResult> {
    requirePositive(request.amount, 'amount')
    return this.call('money.spend', {
      ...options,
      body: { amount: amountToWire(request.amount), reason: request.reason },
    })
  }

  async transfer(request: TransferRequest, options: Options = {}): Promise<MoneyResult> {
    requirePositive(request.amount, 'amount')
    return this.call('money.transfer', {
      ...options,
      body: {
        toUserId: request.toUserId,
        assetCode: request.assetCode,
        amount: amountToWire(request.amount),
      },
    })
  }

  async convert(request: ConvertRequest, options: Options = {}): Promise<MoneyResult> {
    requirePositive(request.amount, 'amount')
    return this.call('money.convert', {
      ...options,
      body: {
        fromAssetCode: request.fromAssetCode,
        toAssetCode: request.toAssetCode,
        amount: amountToWire(request.amount),
      },
    })
  }
}

/* ------------------------------------------------------------------ portfolio */

class PortfolioResource extends Resource {
  /**
   * The one number that is meant to be the truth about what a user holds.
   *
   * Read `portfolio.degraded` before you render a total. It names the upstreams that did not
   * answer, and it is present rather than thrown because a portfolio missing its on-chain half is
   * still worth showing — but only if you say so.
   */
  async get(query: { readonly limit?: number; readonly cursor?: string } = {}, options: Options = {}): Promise<Portfolio> {
    return decodePortfolio(await this.call<Raw>('portfolio.get', { ...options, query: { ...query } }))
  }
}

/* ------------------------------------------------------------------ market */

class MarketResource extends Resource {
  /** Public. No token is sent, because the route makes no `authenticate()` call. */
  async listings(query: ListingsQuery = {}, options: Options = {}): Promise<readonly Listing[]> {
    const body = await this.call<{ listings: Raw[] }>('market.listings', { ...options, query: { ...query } })
    return body.listings.map(decodeListing)
  }

  /** Public. */
  async listing(id: string, options: Options = {}): Promise<{ listing: Listing; royalties: readonly { subject: string; bps: number }[] }> {
    const body = await this.call<{ listing: Raw; royalties: { subject: string; bps: number }[] }>(
      'market.listing',
      { ...options, params: { id } },
    )
    return { listing: decodeListing(body.listing), royalties: body.royalties }
  }

  /**
   * Public. Risk indicators, which fail OPEN.
   *
   * `indicatorsAvailable: false` with an empty `indicators` means the indexer could not be read —
   * NOT that the item is clean. Rendering the two the same way turns a broken upstream into a
   * clean bill of health.
   */
  async risk(id: string, options: Options = {}): Promise<ListingRisk> {
    return this.call('market.risk', { ...options, params: { id } })
  }

  /** Public. */
  async collections(query: { readonly ownerSubject?: string } = {}, options: Options = {}): Promise<{ collections: readonly Collection[] }> {
    return this.call('market.collections', { ...options, query: { ...query } })
  }

  async createCollection(request: { readonly slug: string; readonly name: string; readonly description?: string; readonly royalties?: readonly { readonly subject: string; readonly bps: number }[] }, options: Options = {}): Promise<{ collection: Collection }> {
    return this.call('market.createCollection', { ...options, body: { ...request } })
  }

  /** Requires an idempotency key; one is derived from the request. */
  async createListing(request: CreateListingRequest, options: Options = {}): Promise<{ listing: Listing; replayed: boolean }> {
    const body = await this.call<{ listing: Raw; replayed: boolean }>('market.createListing', {
      ...options,
      body: {
        ...request,
        ...(request.price !== undefined && request.price !== null ? { price: amountToWire(request.price, 'price') } : {}),
        ...(request.quantity !== undefined ? { quantity: amountToWire(request.quantity, 'quantity') } : {}),
        ...(request.reservePrice !== undefined && request.reservePrice !== null
          ? { reservePrice: amountToWire(request.reservePrice, 'reservePrice') }
          : {}),
      },
    })
    return { listing: decodeListing(body.listing), replayed: body.replayed }
  }

  /**
   * Activate a draft listing.
   *
   * For an `onchain` listing the escrow transaction is required and the service FAILS CLOSED on
   * it: an unconfirmed escrow is refused rather than listed anyway.
   */
  async activateListing(id: string, request: { readonly onchainEscrowTx?: string; readonly chain?: string } = {}, options: Options = {}): Promise<{ listing: Listing }> {
    const body = await this.call<{ listing: Raw }>('market.activateListing', {
      ...options,
      params: { id },
      body: { ...request },
    })
    return { listing: decodeListing(body.listing) }
  }

  async cancelListing(id: string, options: Options = {}): Promise<{ listing: Listing }> {
    const body = await this.call<{ listing: Raw }>('market.cancelListing', { ...options, params: { id } })
    return { listing: decodeListing(body.listing) }
  }

  /** Requires an idempotency key; one is derived from the listing id and the amount. */
  async buy(id: string, amount: bigint, options: Options = {}): Promise<{ order: Order; replayed: boolean }> {
    requirePositive(amount, 'amount')
    const body = await this.call<{ order: Raw; replayed: boolean }>('market.buy', {
      ...options,
      params: { id },
      body: { amount: amountToWire(amount) },
    })
    return { order: decodeOrder(body.order), replayed: body.replayed }
  }

  /** Public. */
  async bids(id: string, options: Options = {}): Promise<readonly Bid[]> {
    const body = await this.call<{ bids: Raw[] }>('market.bids', { ...options, params: { id } })
    return body.bids.map(decodeBid)
  }

  async placeBid(id: string, amount: bigint, options: Options = {}): Promise<{ bid: Raw; outbid: string | null; auctionEndsAt: string | null; replayed: boolean }> {
    requirePositive(amount, 'amount')
    return this.call('market.placeBid', { ...options, params: { id }, body: { amount: amountToWire(amount) } })
  }

  /** Public. */
  async offers(id: string, options: Options = {}): Promise<readonly Offer[]> {
    const body = await this.call<{ offers: Raw[] }>('market.offers', { ...options, params: { id } })
    return body.offers.map(decodeOffer)
  }

  async makeOffer(id: string, amount: bigint, request: { readonly expiresAt?: string } = {}, options: Options = {}): Promise<{ offer: Offer; replayed: boolean }> {
    requirePositive(amount, 'amount')
    const body = await this.call<{ offer: Raw; replayed: boolean }>('market.makeOffer', {
      ...options,
      params: { id },
      body: { amount: amountToWire(amount), ...request },
    })
    return { offer: decodeOffer(body.offer), replayed: body.replayed }
  }

  async withdrawOffer(id: string, options: Options = {}): Promise<{ offer: Offer }> {
    const body = await this.call<{ offer: Raw }>('market.withdrawOffer', { ...options, params: { id } })
    return { offer: decodeOffer(body.offer) }
  }

  /** The seller accepts. Settles at the OFFER's amount, not the listing's price. */
  async acceptOffer(id: string, options: Options = {}): Promise<{ order: Order; replayed: boolean }> {
    const body = await this.call<{ order: Raw; replayed: boolean }>('market.acceptOffer', {
      ...options,
      params: { id },
    })
    return { order: decodeOrder(body.order), replayed: body.replayed }
  }

  async orders(query: { readonly role?: 'buyer' | 'seller' } = {}, options: Options = {}): Promise<readonly Order[]> {
    const body = await this.call<{ orders: Raw[] }>('market.orders', { ...options, query: { ...query } })
    return body.orders.map(decodeOrder)
  }

  async order(id: string, options: Options = {}): Promise<{ order: Order }> {
    const body = await this.call<{ order: Raw }>('market.order', { ...options, params: { id } })
    return { order: decodeOrder(body.order) }
  }

  async openDispute(orderId: string, reason: string, options: Options = {}): Promise<{ dispute: Dispute }> {
    return this.call('market.openDispute', { ...options, params: { id: orderId }, body: { reason } })
  }

  /** Public. The URN is percent-encoded into the path — `cf:market:…` contains colons. */
  async verification(urn: string, options: Options = {}): Promise<{ verification: unknown }> {
    return this.call('market.verification', { ...options, params: { urn } })
  }
}

/* ------------------------------------------------------------------ mint */

class MintResource extends Resource {
  /** Public: a catalogue behind a token cannot be browsed. */
  async catalogue(options: Options = {}): Promise<MintCatalogue> {
    return decodeCatalogue(await this.call<Raw>('mint.catalogue', options))
  }

  /** Open an order. Nothing is charged and nothing is deployed. */
  async createToken(request: CreateTokenRequest, options: Options = {}): Promise<{ token: Token }> {
    const body = await this.call<{ token: Raw }>('mint.createToken', {
      ...options,
      body: {
        ...request,
        supply: amountToWire(request.supply, 'supply'),
        ...(request.cap !== undefined && request.cap !== null
          ? { cap: amountToWire(request.cap, 'cap') }
          : {}),
      },
    })
    return { token: decodeToken(body.token) }
  }

  async tokens(options: Options = {}): Promise<readonly Token[]> {
    const body = await this.call<{ tokens: Raw[] }>('mint.tokens', options)
    return body.tokens.map(decodeToken)
  }

  /** The status URL a 202 points at. Cheap and pollable; it reaches no chain. */
  async token(id: string, options: Options = {}): Promise<{ token: Token; attempts: readonly DeployAttempt[] }> {
    const body = await this.call<{ token: Raw; attempts: DeployAttempt[] }>('mint.token', {
      ...options,
      params: { id },
    })
    return { token: decodeToken(body.token), attempts: body.attempts }
  }

  async pay(id: string, options: Options = {}): Promise<{ token: Token; replayed: boolean }> {
    const body = await this.call<{ token: Raw; replayed: boolean }>('mint.pay', { ...options, params: { id } })
    return { token: decodeToken(body.token), replayed: body.replayed }
  }

  /**
   * Enqueue the deploy. **202, and the deploy leaves the request here.**
   *
   * Poll `token(id)` until `status` settles. Nothing about the chain has happened when this
   * resolves; `attempts` on the status read is the evidence of what did.
   */
  async deploy(id: string, options: Options = {}): Promise<DeployAccepted> {
    return this.call('mint.deploy', { ...options, params: { id } })
  }

  async putPage(id: string, page: Raw, options: Options = {}): Promise<{ page: unknown }> {
    return this.call('mint.putPage', { ...options, params: { id }, body: page })
  }

  /**
   * Public. The project page.
   *
   * Supply and authorities on it come from the INDEXER, not from the order record — the difference
   * between a fact and a claim (`mint/src/server.ts:565`).
   */
  async page(id: string, options: Options = {}): Promise<Raw> {
    return this.call('mint.page', { ...options, params: { id } })
  }
}

/* ------------------------------------------------------------------ foresight */

class ForesightResource extends Resource {
  /** Public. Includes the refusal list — a refusal list behind a token binds nobody. */
  async categories(options: Options = {}): Promise<{ version: number; categories: readonly unknown[]; refusals: readonly unknown[] }> {
    return this.call('foresight.categories', options)
  }

  /** Public. */
  async markets(query: { readonly status?: string; readonly limit?: number } = {}, options: Options = {}): Promise<readonly PredictionMarket[]> {
    const body = await this.call<{ markets: PredictionMarket[] }>('foresight.markets', {
      ...options,
      query: { ...query },
    })
    return body.markets
  }

  /**
   * Public. One market, with the canonical document and its hash.
   *
   * Recompute `document.hash` yourself and check it against the contract. That is what it is there
   * for: it proves the criteria have not been edited since the market opened.
   */
  async market(id: string, options: Options = {}): Promise<MarketDetail> {
    const body = await this.call<Raw>('foresight.market', { ...options, params: { id } })
    return {
      ...(body as unknown as MarketDetail),
      pool: decodePool((body['pool'] ?? {}) as Raw),
    }
  }

  /** Public. `stale` and `asOf` say how far behind the chain this mirror is. Render both. */
  async position(id: string, address: string, options: Options = {}): Promise<MarketPosition> {
    return decodePosition(await this.call<Raw>('foresight.position', { ...options, params: { id, address } }))
  }

  /**
   * Everything a wallet needs to stake — and not one wei passes through the platform.
   *
   * The answer is a contract address and calldata; your wallet builds, signs and sends. `amount` is
   * a decimal string of EMBER in wei, and it is echoed rather than acted on. The policy gate here
   * FAILS CLOSED: an unreachable policy service is a 503 and no intent is issued.
   */
  async stakeIntent(id: string, request: { readonly amount: string; readonly outcome: 0 | 1 }, options: Options = {}): Promise<StakeIntent> {
    return this.call('foresight.stakeIntent', { ...options, params: { id }, body: { ...request } })
  }
}

/* ------------------------------------------------------------------ worlds */

class WorldsResource extends Resource {
  /** Public: a launcher listing games cannot require a token to do it. */
  async titles(query: { readonly includeRetired?: boolean } = {}, options: Options = {}): Promise<readonly Title[]> {
    const body = await this.call<{ titles: Title[] }>('worlds.titles', { ...options, query: { ...query } })
    return body.titles
  }

  /**
   * The account-scoped profile and everything it owns.
   *
   * Fails OPEN on the entitlement upstream: this runs on every app load, and a billing outage must
   * not be able to break signing in.
   */
  async player(query: { readonly titleId?: string } = {}, options: Options = {}): Promise<Player> {
    return this.call('worlds.player', { ...options, query: { ...query } })
  }

  async updatePlayer(request: { readonly displayName: string; readonly avatarAssetUrn?: string | null }, options: Options = {}): Promise<{ profile: PlayerProfile }> {
    return this.call('worlds.updatePlayer', { ...options, body: { ...request } })
  }

  /**
   * Equip a cosmetic for one title, or across all of them by omitting `titleId`.
   *
   * Fails CLOSED: a billing outage means "ask again later", not "wear it anyway". Pass
   * `itemUrn: null` to clear a slot — clearing needs no entitlement, because you may always take
   * something off, including something you no longer own.
   */
  async equip(request: { readonly slot: string; readonly itemUrn: string | null; readonly titleId?: string }, options: Options = {}): Promise<{ profile: PlayerProfile }> {
    return this.call('worlds.equip', { ...options, body: { ...request } })
  }

  async inventory(query: { readonly titleId?: string } = {}, options: Options = {}): Promise<readonly InventoryItem[]> {
    const body = await this.call<{ items: InventoryItem[] }>('worlds.inventory', { ...options, query: { ...query } })
    return body.items
  }

  /** A bound item cannot be listed. The refusal is a 403 `item_bound`. */
  async listItem(id: string, listingUrn: string, options: Options = {}): Promise<{ item: InventoryItem }> {
    return this.call('worlds.listItem', { ...options, params: { id }, body: { listingUrn } })
  }

  async unlistItem(id: string, options: Options = {}): Promise<{ item: InventoryItem }> {
    return this.call('worlds.unlistItem', { ...options, params: { id } })
  }

  /** What a customer has been sold, and whether it was delivered. */
  async provisions(query: { readonly state?: string } = {}, options: Options = {}): Promise<{ provisions: readonly unknown[] }> {
    return this.call('worlds.provisions', { ...options, query: { ...query } })
  }

  async provision(id: string, options: Options = {}): Promise<{ provision: unknown }> {
    return this.call('worlds.provision', { ...options, params: { id } })
  }

  /** Public. */
  async achievements(titleId: string, options: Options = {}): Promise<readonly Achievement[]> {
    const body = await this.call<{ achievements: Raw[] }>('worlds.achievements', {
      ...options,
      params: { id: titleId },
    })
    return body.achievements.map(decodeAchievement)
  }

  /** Public. */
  async seasons(titleId: string, options: Options = {}): Promise<{ seasons: readonly unknown[] }> {
    return this.call('worlds.seasons', { ...options, params: { id: titleId } })
  }
}

/* ------------------------------------------------------------------ activity */

class ActivityResource extends Resource {
  /**
   * One activity history — every account, money, asset, game and governance event on one timeline.
   *
   * A user token reads its own feed and nobody else's. Records classified `internal` are never in
   * it; those are an operator's and are not part of this SDK's surface.
   */
  async feed(query: FeedQuery = {}, options: Options = {}): Promise<{ records: readonly ActivityRecord[]; nextCursor?: string }> {
    const body = await this.call<{ records: Raw[]; nextCursor?: string }>('activity.feed', {
      ...options,
      query: { ...query },
    })
    return {
      records: body.records.map(decodeActivityRecord),
      ...(body.nextCursor !== undefined ? { nextCursor: body.nextCursor } : {}),
    }
  }

  async record(id: string, options: Options = {}): Promise<{ record: ActivityRecord }> {
    const body = await this.call<{ record: Raw }>('activity.record', { ...options, params: { id } })
    return { record: decodeActivityRecord(body.record) }
  }
}

/* ------------------------------------------------------------------ identity */

class IdentityResource extends Resource {
  /**
   * Who this token belongs to.
   *
   * **Requires a USER token.** `identity/src/server.ts:540` refuses a service principal outright,
   * so an API key or a client-credentials token gets 403 here, not 401 — the credential was
   * understood and refused. There is no route that answers the same question for a machine
   * credential, and this SDK does not pretend otherwise.
   */
  async me(options: Options = {}): Promise<Me> {
    return this.call('identity.me', options)
  }
}

/* ------------------------------------------------------------------ helpers */

function requirePositive(amount: bigint, field: string): void {
  if (amount <= 0n) throw new UsageError(`${field} must be positive (got ${amount})`)
}
