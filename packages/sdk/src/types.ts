/**
 * The response shapes, as the services actually produce them.
 *
 * ## Amounts are `bigint` here and decimal strings on the wire
 *
 * Every service serialises money as a decimal string — `listingWire` at `market/src/server.ts`
 * says why in one line: "Every amount a decimal STRING. A JSON number is an IEEE 754 double." The
 * SDK converts on the way in, so a caller never sees a money field typed `string` and never has to
 * remember which of the twenty fields on an order is one. `decode.ts` does the conversion; the
 * fields converted are named there, one at a time, against the wire shape they came from.
 *
 * ## Unknown fields survive
 *
 * The decoders spread the raw object and overwrite the money fields. A field the platform adds
 * tomorrow reaches a caller who has not upgraded, which is what
 * `docs/ecosystem/11-data-and-contract-strategy.md` promises — "additive changes need no
 * version" — and it only holds if the client does not strip what it does not recognise.
 *
 * ## The types are narrower than the wire in one direction only
 *
 * Where a service returns a field this SDK has no business exposing, the field is absent from the
 * type and present at runtime. Nothing is removed. The one thing worth knowing is what is NOT on
 * the wire at all: `market`'s listing reserve price is withheld by the service
 * (`market/src/server.ts`), because publishing a seller's secret floor is the same as not
 * having one.
 */

import type { AssetCode, Network } from './chain.ts'

/* ------------------------------------------------------------------ shared */

/** A page. Callers page until `nextCursor` is null, never by counting — `wallet/src/wallets.ts`. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/* ------------------------------------------------------------------ pricing */

/** `pricing/src/quotes.ts`. Every `*Scaled` field is an integer at `RATE_SCALE`. */
export interface Rate {
  readonly asset: AssetCode
  readonly source: string
  /** False means there is no usable quote and `reason` says why. Shown, not hidden. */
  readonly usable: boolean
  readonly reason?: string
  readonly sourceCount: number
  readonly divergenceBps: string | null
  readonly quotedAt: string | null
  readonly ageSeconds: number | null
  /** Mid-market, before the spread, at `RATE_SCALE`. Null when there is no usable quote. */
  readonly usdScaled: bigint | null
  readonly usd: string | null
  /** The user SELLS coin into the platform at this price; the spread is deducted. */
  readonly usdSellScaled: bigint | null
  readonly usdSell: string | null
  /** The user BUYS coin from the platform at this price; the spread is added. */
  readonly usdBuyScaled: bigint | null
  readonly usdBuy: string | null
  readonly shardsPerCoinSellScaled: bigint | null
  readonly shardsPerCoinSell: string | null
  readonly shardsPerCoinBuyScaled: bigint | null
  readonly shardsPerCoinBuy: string | null
  readonly lastFailure: string | null
  readonly lastFailureAt: string | null
  /** The scale the `*Scaled` fields use, so a consumer never has to assume it. */
  readonly rateScale: bigint
}

export interface RateBoard {
  readonly rates: readonly Rate[]
  readonly spreadBps: number
}

/* ------------------------------------------------------------------ wallet */

export type WalletOrigin = 'managed' | 'external' | 'watch'

/**
 * `wallet/src/wallets.ts`. Each terminal is terminal for a different reason:
 * `exported` means the user holds the private key and is irreversible; `frozen` cannot send but
 * can still receive, and is reversible.
 */
export type WalletStatus =
  | 'provisioning'
  | 'active'
  | 'frozen'
  | 'exported'
  | 'retiring'
  | 'retired'

/** `wallet/src/wallets.ts`. No amounts: a wallet record carries no balance. */
export interface Wallet {
  readonly id: string
  readonly userId: string
  readonly origin: WalletOrigin
  readonly chain: string
  readonly network: Network
  /** Display form: EIP-55 for EVM and Ember. */
  readonly address: string
  readonly label: string | null
  readonly isPrimary: boolean
  readonly status: WalletStatus
  readonly custodyKeyUrn: string | null
  readonly createdAt: string
  readonly verifiedAt: string | null
  readonly exportedAt: string | null
  readonly retiredAt: string | null
}

/** `wallet/src/links.ts`. What a linked external wallet is permitted to be used for. */
export type WalletAuthorisation = string

export interface WalletLink {
  readonly walletId: string
  readonly scheme: string
  readonly authorisations: readonly WalletAuthorisation[]
}

/** The challenge a `POST /v1/wallets` with `origin: 'external'` returns, for signing. */
export interface WalletChallenge {
  readonly nonce: string
  readonly message: string
  readonly expiresAt: string
}

/** `pricing`'s valuation, embedded in a portfolio balance. Never a number on its own. */
export interface Valuation {
  /** USD at `RATE_SCALE`. */
  readonly usdScaled: bigint
  /** When the market observation was made, not when this response was assembled. */
  readonly quotedAt: string
  readonly source: string
}

/** `wallet/src/portfolio.ts`. */
export interface PortfolioBalance {
  readonly assetCode: AssetCode
  readonly purpose: string
  /** Smallest units. */
  readonly amount: bigint
  readonly amountFormatted: string
  /** Null when pricing has no usable quote. A holding with no price is shown, not hidden. */
  readonly valuation: Valuation | null
}

/**
 * `wallet/src/portfolio.ts`.
 *
 * `balance` is ALWAYS null and that is not an omission: the indexer exposes no balance read, and a
 * `balance` field containing something that is not the balance would be rendered as one.
 * `netObserved` is confirmed-in minus confirmed-out over the window this read saw — useful for
 * "has anything happened here", useless for "how much is there".
 */
export interface ObservedWallet {
  readonly walletId: string
  readonly origin: WalletOrigin
  readonly chain: string
  readonly network: string
  readonly address: string
  readonly label: string | null
  readonly status: string
  readonly balance: null
  readonly balanceUnavailable: 'indexer_exposes_no_balance_read'
  readonly netObserved: bigint
  /** True when the whole activity history fitted in the window, so `netObserved` covers all of it. */
  readonly complete: boolean
  readonly movements: number
  readonly lastActivityAt: string | null
  readonly observedAt: string
}

/** `wallet/src/portfolio.ts`. */
export interface Portfolio {
  readonly subject: string
  readonly network: Network
  readonly balances: readonly PortfolioBalance[]
  readonly wallets: readonly ObservedWallet[]
  readonly nextCursor: string | null
  /**
   * Which upstreams did not answer. Present rather than thrown: a portfolio missing its on-chain
   * half is still worth showing. Render it — an empty `degraded` and a hidden failure look the
   * same to a user otherwise.
   */
  readonly degraded: readonly string[]
  readonly asOf: string
}

/** `wallet/src/deposits.ts`. */
export interface DepositAssignment {
  readonly id: string
  readonly userId: string
  readonly assetCode: AssetCode
  readonly chain: string
  readonly network: Network
  readonly walletId: string
  readonly address: string
  readonly custodyKeyUrn: string
  readonly status: 'active' | 'rotated' | 'retired'
  readonly assignedAt: string
  readonly rotatedAt: string | null
  readonly supersedesId: string | null
  /** Null until the indexer has been told to watch it. An unwatched address produces no events. */
  readonly watchedAt: string | null
}

/** `wallet/src/deposits.ts`. */
export interface DepositCredit {
  readonly id: string
  readonly assetCode: string
  readonly amount: bigint
  readonly amountFormatted: string
  readonly chain: string
  readonly network: string
  readonly txHash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly confirmations: number
  readonly credited: boolean
}

/**
 * `wallet/src/withdrawals.ts`.
 *
 * `stuck` is NOT terminal, and that is the important entry: a stuck withdrawal holds a reservation
 * against a user who has been debited, and it must be able to become `settled` or `failed`.
 */
export type WithdrawalState =
  | 'requested'
  | 'reserved'
  | 'queued'
  | 'settling'
  | 'settled'
  | 'stuck'
  | 'failed'
  | 'refunded'
  | 'cancelled'

/** `wallet/src/withdrawals.ts`. */
export interface Withdrawal {
  readonly id: string
  readonly userId: string
  readonly chain: string
  readonly network: Network
  readonly assetCode: AssetCode
  readonly destination: string
  readonly destinationWalletId: string | null
  readonly amount: bigint
  readonly amountFormatted: string
  readonly fee: bigint
  readonly net: bigint
  readonly netFormatted: string
  readonly state: WithdrawalState
  readonly reservationEntryId: string | null
  readonly txHash: string | null
  readonly failureReason: string | null
  readonly requestedAt: string
  readonly updatedAt: string
}

/**
 * `wallet/src/money.ts`.
 *
 * `replayed` is the field to branch on. The service answers 201 on a fresh posting and 200 on a
 * replay so a client can tell "I did this" from "this was already done" without comparing bodies
 * (`wallet/src/server.ts`), and this carries the same fact into the body.
 */
export interface MoneyResult {
  readonly entryId: string
  readonly replayed: boolean
  readonly summary: Readonly<Record<string, unknown>>
}

/* ------------------------------------------------------------------ market */

export type ListingStatus = string
export type AssetKind = string
export type PricingMode = string
export type SettlementMode = string

/** `market/src/server.ts`. The reserve price is deliberately absent — it is the seller's. */
export interface Listing {
  readonly id: string
  readonly sellerSubject: string
  readonly collectionId: string | null
  readonly assetKind: AssetKind
  readonly itemUrn: string
  readonly quantity: bigint
  readonly itemAssetCode: string
  readonly pricingMode: PricingMode
  readonly price: bigint | null
  readonly assetCode: string
  readonly settlementMode: SettlementMode
  readonly royaltyBps: number
  readonly platformFeeBps: number
  readonly auctionEndsAt: string | null
  readonly expiresAt: string | null
  readonly status: ListingStatus
  readonly frozen: boolean
  readonly escrowed: boolean
  readonly createdAt: string
}

export interface RoyaltyShare {
  readonly subject: string
  readonly amount: bigint
}

/** `market/src/server.ts`. */
export interface Order {
  readonly id: string
  readonly listingId: string
  readonly buyerSubject: string
  readonly sellerSubject: string
  readonly itemUrn: string
  readonly quantity: bigint
  readonly amount: bigint
  readonly feeAmount: bigint
  readonly royaltyAmount: bigint
  readonly sellerProceeds: bigint
  readonly assetCode: string
  readonly settlementMode: SettlementMode
  readonly journalEntryId: string | null
  readonly outboundTransactionId: string | null
  readonly source: string
  readonly proceedsState: string
  readonly payoutDueAt: string | null
  readonly settledAt: string
  readonly royalties: readonly RoyaltyShare[]
}

/** `market/src/server.ts`. */
export interface Bid {
  readonly id: string
  readonly bidderSubject: string
  readonly amount: bigint
  readonly assetCode: string
  readonly status: string
  readonly placedAt: string
}

/** `market/src/server.ts`. */
export interface Offer {
  readonly id: string
  readonly listingId: string
  readonly offererSubject: string
  readonly amount: bigint
  readonly assetCode: string
  readonly status: string
  readonly expiresAt: string | null
  readonly createdAt: string
}

/** `market/src/server.ts`. */
export interface Dispute {
  readonly id: string
  readonly orderId: string
  readonly raiserSubject: string
  readonly reason: string
  readonly state: string
  readonly resolutionEntryId: string | null
  readonly openedAt: string
}

export interface Collection {
  readonly id: string
  readonly ownerSubject: string
  readonly slug: string
  readonly name: string
  readonly description: string
}

/**
 * `market/src/server.ts`.
 *
 * `indicatorsAvailable` is said explicitly rather than inferred from an empty array, and a client
 * must honour that: "we have no indicators" and "we could not fetch them" must not look the same,
 * or a broken indexer renders as a clean bill of health.
 */
export interface ListingRisk {
  readonly verification: unknown
  readonly indicators: readonly unknown[]
  readonly indicatorsAvailable: boolean
}

/* ------------------------------------------------------------------ mint */

/** `mint/src/server.ts`. */
export interface Token {
  readonly id: string
  readonly ownerSubject: string
  readonly ownerAddress: string
  readonly chain: string
  readonly network: Network
  readonly standard: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly supply: bigint
  readonly cap: bigint | null
  readonly features: readonly string[]
  readonly status: string
  readonly priceShards: bigint
  readonly paidJournalEntryId: string | null
  readonly deployerAddress: string | null
  readonly contractAddress: string | null
  readonly deployTxHash: string | null
  readonly broadcastAt: string | null
  readonly confirmedAt: string | null
  readonly failureReason: string | null
  readonly deployAttempts: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DeployAttempt {
  readonly attempt: number
  readonly family: string
  readonly outcome: string
  readonly txHash: string | null
  readonly detail: string | null
  readonly at: string
}

export interface MintCatalogue {
  readonly priceShards: bigint
  readonly network: Network
  readonly variants: readonly {
    readonly variant: string
    readonly contract: string
    readonly features: readonly string[]
    readonly cap: unknown
  }[]
}

/** `mint/src/server.ts`. The deploy leaves the request here; poll `statusUrl`. */
export interface DeployAccepted {
  readonly accepted: true
  readonly tokenId: string
  readonly status: string
  readonly statusUrl: string
}

/* ------------------------------------------------------------------ foresight */

/** `foresight/src/markets.ts`. */
export interface PredictionMarket {
  readonly id: string
  readonly status: string
  readonly question: string
  readonly resolutionCriteria: string
  readonly category: string
  readonly categoryVersion: number
  readonly resolutionSourceKind: string
  readonly resolutionSourceRef: string | null
  /** Hash of the canonical document. Recomputable by the reader — that is the point of it. */
  readonly questionHash: string
  readonly closeTime: string
  readonly disputeWindowSeconds: number
  readonly feeBps: number
  readonly chain: string
  readonly network: string
  readonly contractAddress: string | null
  readonly outcome: number | null
  readonly voidReason: string | null
  readonly openedAt: string | null
  readonly closedAt: string | null
  readonly resolvedAt: string | null
  readonly settledAt: string | null
  readonly voidedAt: string | null
}

/**
 * `foresight/src/mirror.ts`.
 *
 * `asOf` and `stale` are not optional decoration. This is a MIRROR of on-chain state, and a pool
 * shown without saying when it was last read is a pool a reader will assume is live.
 */
export interface MarketPool {
  readonly yes: bigint
  readonly no: bigint
  readonly total: bigint
  readonly yesBps: number | null
  readonly noBps: number | null
  readonly stakerCount: number
  readonly asOf: string | null
  readonly lastBlock: number | null
  readonly tipBlock: number | null
  readonly behindBlocks: number | null
  readonly stale: boolean
}

export interface MarketDetail {
  readonly market: PredictionMarket
  readonly pool: MarketPool
  readonly document: { readonly canonical: string; readonly hash: string }
  readonly provenance: {
    readonly origin: string
    readonly searchQuery: string | null
    readonly sources: readonly unknown[]
    readonly modelId: string | null
    readonly promptSha256: string | null
    readonly proposedAt: string
  } | null
}

export interface MarketPosition {
  readonly marketId: string
  readonly address: string
  readonly position: { readonly yes: bigint; readonly no: bigint }
  readonly asOf: string | null
  readonly stale: boolean
  readonly contractAddress: string | null
}

/**
 * `foresight/src/server.ts`.
 *
 * **Not one wei passes through the platform.** The answer is a contract address and calldata; the
 * user's wallet builds, signs and sends. `value` is deliberately not computed here — the wallet is
 * what knows the user's balance and what will actually be sent.
 */
export interface StakeIntent {
  readonly marketId: string
  readonly chain: string
  readonly network: string
  readonly to: string
  readonly data: string
  readonly outcome: number
  readonly amount: string
  readonly asset: 'EMBER'
  readonly policy: {
    readonly decision: string
    readonly reasons: readonly string[]
    readonly decisionId: string | null
  }
  readonly closeTime: string
}

/* ------------------------------------------------------------------ worlds */

export interface Title {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly status: string
  readonly capabilities: readonly string[]
  readonly assetScopes: readonly string[]
}

/** `worlds/src/players.ts`. */
export interface PlayerProfile {
  readonly userId: string
  readonly displayName: string
  readonly avatarAssetUrn: string | null
  readonly reputation: number
  /** `titleId | '*'` → `{ slot: cosmeticUrn }`. */
  readonly equippedCosmetics: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly sanctions: readonly unknown[]
  readonly ageBracket: string
  readonly parentalControls: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly updatedAt: string
}

/** `worlds/src/server.ts`. `bound` is on the wire so a client knows before it draws a Sell. */
export interface InventoryItem {
  readonly id: string
  readonly titleScope: string
  readonly itemUrn: string
  readonly source: string
  readonly quantity: number
  readonly bound: boolean
  readonly entitlementId: string | null
  readonly listedAt: string | null
  readonly listingUrn: string | null
  readonly acquiredAt: string
}

export interface UnlockedAchievement {
  readonly key: string
  readonly titleId: string
  readonly name: string
  readonly points: number
  readonly unlockedAt: string
}

export interface Achievement {
  readonly key: string
  readonly titleId: string
  readonly name: string
  readonly description: string
  readonly points: number
  readonly rewardShards: bigint
}

export interface Player {
  readonly profile: PlayerProfile | null
  readonly inventory: readonly InventoryItem[]
  readonly achievements: readonly UnlockedAchievement[]
}

/* ------------------------------------------------------------------ activity */

/** `activity/src/categories.ts`. Sixteen, and `unclassified` is not one of them. */
export type ActivityCategory =
  | 'account'
  | 'security'
  | 'wallet'
  | 'deposit'
  | 'withdrawal'
  | 'transfer'
  | 'conversion'
  | 'token'
  | 'ownership'
  | 'trading'
  | 'market'
  | 'reward'
  | 'community'
  | 'governance'
  | 'api'
  | 'billing'

/** `activity/src/server.ts`. */
export interface ActivityRecord {
  readonly id: string
  readonly userId: string | null
  readonly occurredAt: string
  readonly recordedAt: string
  readonly category: ActivityCategory | 'unclassified'
  readonly type: string
  readonly subjectUrn: string | null
  readonly summary: string
  readonly amount: bigint | null
  readonly assetCode: string | null
  /** The id to quote at support, carried on the record itself. */
  readonly correlationId: string | null
  readonly sourceEventId: string
  readonly sourceTopic: string
  readonly product: string
  readonly visibility: 'user' | 'internal'
}

/* ------------------------------------------------------------------ identity */

/** `contracts/packages/auth/src/index.ts`, produced by `identity/src/users.ts`. */
export interface PublicUser {
  readonly id: string
  readonly email: string
  readonly emailVerifiedAt: string | null
  readonly handle: string
  readonly status: string
  readonly roles: readonly string[]
  readonly createdAt: string
  readonly lastSeenAt: string | null
}

export interface Organisation {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: string
  readonly status: string
  readonly createdAt: string
  readonly role: string
}

export interface Me {
  readonly user: PublicUser
  readonly session: { readonly id: string; readonly amr: readonly string[] }
  readonly organisations: readonly Organisation[]
}
