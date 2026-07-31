/**
 * `@cloudsforge/sdk` — the typed client for the CloudsForge public API.
 *
 * ```ts
 * import { CloudsForge, apiKey, formatAmount, decimalsFor } from '@cloudsforge/sdk'
 *
 * const cf = new CloudsForge({
 *   baseUrl: 'https://api.cloudsforge.online',
 *   credential: apiKey(process.env.CLOUDSFORGE_API_KEY!),
 * })
 *
 * const board = await cf.pricing.rates()          // public: no credential needed
 * const listings = await cf.market.listings()     // public
 * const portfolio = await cf.portfolio.get()      // needs a credential
 *
 * for (const balance of portfolio.balances) {
 *   console.log(balance.assetCode, formatAmount(balance.amount, decimalsFor(balance.assetCode)))
 * }
 * ```
 *
 * THIS FILE IS THE PUBLIC SURFACE. Everything re-exported here is something a caller may depend
 * on; anything not exported here is free to change. Removing or narrowing a name below is a
 * breaking change, and `contract-compat.yml` fails the build for one — see the README.
 */

export { CloudsForge } from './client.ts'
export type {
  CloudsForgeOptions,
  ConvertRequest,
  CreateListingRequest,
  CreateTokenRequest,
  FeedQuery,
  ListingsQuery,
  ListWalletsQuery,
  Options,
  RegisterWalletRequest,
  SpendRequest,
  TransferRequest,
  UpdateWalletRequest,
  VerifyWalletRequest,
  WithdrawRequest,
} from './client.ts'

export { anonymous, apiKey, bearerToken, clientCredentials } from './credentials.ts'
export type { ClientCredentialsOptions, Credential } from './credentials.ts'

export {
  ApiError,
  AuthError,
  CloudsForgeError,
  TimeoutError,
  TransportError,
  UsageError,
  parseErrorBody,
} from './errors.ts'
export type { ApiErrorBody } from './errors.ts'

export { Transport, SDK_VERSION } from './transport.ts'
export type { CallOptions, RequestEvent, TransportOptions } from './transport.ts'

export { ROUTES, ROUTE_NAMES, fillPath } from './routes.ts'
export type { RouteAuth, RouteIdempotency, RouteName, RouteSpec } from './routes.ts'

export {
  PER_ATTEMPT_FIELDS,
  assertValidKey,
  deriveKey,
  newKey,
  requestFingerprint,
} from './idempotency.ts'

export {
  amountToWire,
  formatAmount,
  parseAmount,
  toAmount,
  toAmountOrNull,
  toSignedAmount,
} from './money.ts'

export {
  ASSETS,
  ASSET_CODES,
  ON_CHAIN_ASSETS,
  RATE_SCALE,
  RATE_SCALE_DECIMALS,
  SHARDS_PER_USD,
  assetSpec,
  decimalsFor,
  isAssetCode,
  isConfirmed,
} from './chain.ts'
export type { AssetCode, AssetSpec, ChainFamily, Network } from './chain.ts'

export type {
  Achievement,
  ActivityCategory,
  ActivityRecord,
  AssetKind,
  Bid,
  Collection,
  DeployAccepted,
  DeployAttempt,
  DepositAssignment,
  DepositCredit,
  Dispute,
  InventoryItem,
  Listing,
  ListingRisk,
  ListingStatus,
  MarketDetail,
  MarketPool,
  MarketPosition,
  Me,
  MintCatalogue,
  MoneyResult,
  ObservedWallet,
  Offer,
  Order,
  Organisation,
  Page,
  Player,
  PlayerProfile,
  Portfolio,
  PortfolioBalance,
  PredictionMarket,
  PricingMode,
  PublicUser,
  Rate,
  RateBoard,
  RoyaltyShare,
  SettlementMode,
  StakeIntent,
  Title,
  Token,
  UnlockedAchievement,
  Valuation,
  Wallet,
  WalletAuthorisation,
  WalletChallenge,
  WalletLink,
  WalletOrigin,
  WalletStatus,
  Withdrawal,
  WithdrawalState,
} from './types.ts'
