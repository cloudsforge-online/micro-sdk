/**
 * Chain and asset facts, DUPLICATED from `@cloudsforge/contracts-chain` on purpose.
 *
 * ## Why this file is a copy and not an import
 *
 * The contracts package these values come from is published from a PRIVATE repository. Every
 * service in the estate consumes it with a `link:` or a workspace dependency. This package cannot:
 * it is the only public repository in the programme, and `pnpm install @cloudsforge/sdk` has to
 * succeed for somebody with no access to anything of ours. A published package that depends on a
 * repository nobody can fetch is not a published package.
 *
 * Three options were available and the README records the argument in full. In short:
 *
 *   - **Generate from OpenAPI.** The contract strategy names this as the eventual mechanism. There
 *     is no committed OpenAPI description anywhere in the estate today — checked, not assumed — so
 *     generating from it now would mean generating from nothing.
 *   - **Vendor the contract packages wholesale.** They carry internal surface: service-token
 *     claims, actor vocabularies, operator shapes. Publishing them would break the rule this
 *     repository exists to hold.
 *   - **Duplicate the narrow set of values this SDK actually needs, and check the copy.** Chosen.
 *
 * ## Why duplication is safe here and only here
 *
 * The upstream is the one package the estate already exact-pins rather than caret-ranges, and its
 * own header says why: a skew in the rate scale, in a confirmation depth, or in a rounding
 * direction is not a 500 — it is money credited at the wrong depth. Duplicating something with
 * that property is only defensible with a check, so there is one. `tools/drift.ts` reads the real
 * upstream source and fails on any disagreement with the values below; CI runs it against a
 * sibling checkout. It is a separate job from `pnpm test` because the test suite must pass for a
 * stranger holding only the tarball, and a stranger has no upstream to compare against.
 *
 * The copy is deliberately NARROW. Confirmation depths, decimals and the rate scale — the values a
 * developer needs to render an amount and to know when a deposit is final. Not the arithmetic that
 * decides credits: that belongs to the services, and an SDK that reimplemented it would be inviting
 * a third party to compute a credit the platform disagrees with. `formatAmount`/`parseAmount` in
 * `money.ts` are the exception, because rendering is the client's job and there is no way to do it
 * correctly without them.
 */

export type ChainFamily = 'evm' | 'ember' | 'solana' | 'bitcoin' | 'xrp'

export type Network = 'mainnet' | 'testnet'

export type AssetCode = 'EMBER' | 'BTC' | 'ETH' | 'LTC' | 'SOL' | 'XRP' | 'SHARD'

export interface AssetSpec {
  readonly asset: AssetCode
  readonly family: ChainFamily
  readonly name: string
  /** Smallest-unit exponent. EMBER is 18 because Hearth is an account-model EVM chain. */
  readonly decimals: number
  /** Blocks (or ledgers) before a deposit is credited. */
  readonly confirmations: number
}

/**
 * The supported assets.
 *
 * EMBER's depth of 60 (~15 minutes at a 15-second block time) is high because Hearth is a young
 * CPU-mined chain with no finality gadget, and depth is the only defence available. A client that
 * shows "deposited" before that depth is showing something the platform has not credited.
 */
export const ASSETS: Readonly<Record<AssetCode, AssetSpec>> = Object.freeze({
  EMBER: Object.freeze({ asset: 'EMBER', family: 'ember', name: 'Hearth', decimals: 18, confirmations: 60 }),
  ETH: Object.freeze({ asset: 'ETH', family: 'evm', name: 'Ethereum', decimals: 18, confirmations: 12 }),
  // SIX, NOT THREE. This said 3 until 2026-08-05, while the platform has credited at 6 since
  // native deposits were built — so every integration built on this SDK was told a Bitcoin deposit
  // was final roughly half an hour before the platform agreed. `tools/drift.ts` was reporting it
  // the whole time; nothing in CI was failing on the report. See the header of that file.
  BTC: Object.freeze({ asset: 'BTC', family: 'bitcoin', name: 'Bitcoin', decimals: 8, confirmations: 6 }),
  // Litecoin. Bitcoin's family, and deliberately NOT Bitcoin's depth: ~2.5-minute blocks on a
  // fraction of Bitcoin's hashrate, so twelve confirmations is ~30 minutes rather than six being
  // fifteen. Copying the number because the family matches is the mistake upstream warns about.
  LTC: Object.freeze({ asset: 'LTC', family: 'bitcoin', name: 'Litecoin', decimals: 8, confirmations: 12 }),
  SOL: Object.freeze({ asset: 'SOL', family: 'solana', name: 'Solana', decimals: 9, confirmations: 32 }),
  XRP: Object.freeze({ asset: 'XRP', family: 'xrp', name: 'XRP Ledger', decimals: 6, confirmations: 1 }),
  // Shards never touch a chain. Present so the record is total and a lookup cannot be undefined.
  SHARD: Object.freeze({ asset: 'SHARD', family: 'evm', name: 'Shards', decimals: 0, confirmations: 0 }),
})

/** The assets that exist on a chain. Shards do not, which is the whole of the distinction. */
export const ON_CHAIN_ASSETS: readonly AssetCode[] = Object.freeze([
  'EMBER',
  'BTC',
  'ETH',
  'LTC',
  'SOL',
  'XRP',
])

export const ASSET_CODES: readonly AssetCode[] = Object.freeze([
  'EMBER',
  'BTC',
  'ETH',
  'LTC',
  'SOL',
  'XRP',
  'SHARD',
])

export function isAssetCode(value: string): value is AssetCode {
  return (ASSET_CODES as readonly string[]).includes(value)
}

/**
 * Fixed-point scale for exchange rates. Six decimal places, as a bigint.
 *
 * Every `*Scaled` field the pricing service returns is an integer at this scale. Dividing one by
 * `1e6` as a float is the mistake this constant exists to make avoidable: use
 * `formatAmount(usdScaled, RATE_SCALE_DECIMALS)`.
 */
export const RATE_SCALE = 1_000_000n

/** `log10(RATE_SCALE)`, so a caller never has to count the zeroes to render a rate. */
export const RATE_SCALE_DECIMALS = 6

/** Shards per US dollar. 100 Shards = 1 USD, fixed. */
export const SHARDS_PER_USD = 100n

export function assetSpec(asset: AssetCode): AssetSpec {
  const spec = ASSETS[asset]
  if (!spec) throw new RangeError(`unknown asset: ${asset}`)
  return spec
}

/** How many decimal places this asset's smallest unit implies. */
export function decimalsFor(asset: AssetCode): number {
  return assetSpec(asset).decimals
}

/**
 * Has this deposit reached the depth at which the platform credits it?
 *
 * Reported rather than decided: the platform's credit is the platform's, and this only tells a
 * client whether to stop showing a spinner. `>=` matches the service, which credits AT the depth
 * and not one block after it.
 */
export function isConfirmed(asset: AssetCode, confirmations: number): boolean {
  return confirmations >= assetSpec(asset).confirmations
}
