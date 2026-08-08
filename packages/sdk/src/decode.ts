/**
 * Wire → domain. The only place a decimal string becomes a `bigint`.
 *
 * Every function here follows one shape:
 *
 *     { ...raw, amount: toAmount(raw.amount) }
 *
 * The spread is load-bearing. A field the platform adds tomorrow reaches a caller who has not
 * upgraded — which is the promise `docs/ecosystem/11-data-and-contract-strategy.md` makes
 * ("additive changes need no version") and which only holds if the client does not strip what it
 * does not recognise. A decoder that constructed a fresh object field by field would quietly
 * discard every additive change, and the caller would have no way to tell.
 *
 * `toAmount` refuses a JSON number that is not already a safe integer, so a service that ever
 * regressed to sending a number for a money field would fail loudly here rather than silently
 * hand a caller a value that is not the one it was sent.
 */

import { toAmount, toAmountOrNull, toSignedAmount } from './money.ts'
import type {
  ActivityRecord,
  Achievement,
  Bid,
  DepositCredit,
  Listing,
  MarketPool,
  MarketPosition,
  MintCatalogue,
  ObservedWallet,
  Offer,
  Order,
  Portfolio,
  PortfolioBalance,
  Rate,
  RateBoard,
  Token,
  Valuation,
  Withdrawal,
} from './types.ts'

type Raw = Readonly<Record<string, unknown>>

/* ------------------------------------------------------------------ pricing */

export function decodeRate(raw: Raw): Rate {
  return {
    ...(raw as unknown as Rate),
    usdScaled: toAmountOrNull(raw['usdScaled'], 'usdScaled'),
    usdSellScaled: toAmountOrNull(raw['usdSellScaled'], 'usdSellScaled'),
    usdBuyScaled: toAmountOrNull(raw['usdBuyScaled'], 'usdBuyScaled'),
    shardsPerCoinSellScaled: toAmountOrNull(raw['shardsPerCoinSellScaled'], 'shardsPerCoinSellScaled'),
    shardsPerCoinBuyScaled: toAmountOrNull(raw['shardsPerCoinBuyScaled'], 'shardsPerCoinBuyScaled'),
    rateScale: toAmount(raw['rateScale'], 'rateScale'),
  }
}

export function decodeRateBoard(raw: Raw): RateBoard {
  return {
    ...(raw as unknown as RateBoard),
    rates: asArray(raw['rates']).map(decodeRate),
  }
}

/* ------------------------------------------------------------------ wallet */

export function decodeValuation(raw: Raw | null): Valuation | null {
  if (raw === null) return null
  return { ...(raw as unknown as Valuation), usdScaled: toAmount(raw['usdScaled'], 'usdScaled') }
}

export function decodePortfolioBalance(raw: Raw): PortfolioBalance {
  return {
    ...(raw as unknown as PortfolioBalance),
    amount: toAmount(raw['amount'], 'amount'),
    valuation: decodeValuation((raw['valuation'] ?? null) as Raw | null),
  }
}

/**
 * `netObserved` is confirmed-in minus confirmed-out, so it is the one public money field that can
 * be negative — `toSignedAmount`, not `toAmount`. `balance` is left exactly as it arrives, which is
 * always `null`: the indexer exposes no balance read, and a client that substituted `netObserved`
 * for it would be rendering a movement as a holding.
 */
export function decodeObservedWallet(raw: Raw): ObservedWallet {
  return {
    ...(raw as unknown as ObservedWallet),
    netObserved: toSignedAmount(raw['netObserved'], 'netObserved'),
  }
}

export function decodePortfolio(raw: Raw): Portfolio {
  return {
    ...(raw as unknown as Portfolio),
    balances: asArray(raw['balances']).map(decodePortfolioBalance),
    wallets: asArray(raw['wallets']).map(decodeObservedWallet),
  }
}

export function decodeDepositCredit(raw: Raw): DepositCredit {
  return { ...(raw as unknown as DepositCredit), amount: toAmount(raw['amount'], 'amount') }
}

export function decodeWithdrawal(raw: Raw): Withdrawal {
  return {
    ...(raw as unknown as Withdrawal),
    amount: toAmount(raw['amount'], 'amount'),
    fee: toAmount(raw['fee'], 'fee'),
    net: toAmount(raw['net'], 'net'),
  }
}

/* ------------------------------------------------------------------ market */

export function decodeListing(raw: Raw): Listing {
  return {
    ...(raw as unknown as Listing),
    quantity: toAmount(raw['quantity'], 'quantity'),
    price: toAmountOrNull(raw['price'], 'price'),
  }
}

export function decodeOrder(raw: Raw): Order {
  return {
    ...(raw as unknown as Order),
    quantity: toAmount(raw['quantity'], 'quantity'),
    amount: toAmount(raw['amount'], 'amount'),
    feeAmount: toAmount(raw['feeAmount'], 'feeAmount'),
    royaltyAmount: toAmount(raw['royaltyAmount'], 'royaltyAmount'),
    sellerProceeds: toAmount(raw['sellerProceeds'], 'sellerProceeds'),
    royalties: asArray(raw['royalties']).map((share) => ({
      ...(share as unknown as { subject: string; amount: bigint }),
      amount: toAmount(share['amount'], 'royalties[].amount'),
    })),
  }
}

export function decodeBid(raw: Raw): Bid {
  return { ...(raw as unknown as Bid), amount: toAmount(raw['amount'], 'amount') }
}

export function decodeOffer(raw: Raw): Offer {
  return { ...(raw as unknown as Offer), amount: toAmount(raw['amount'], 'amount') }
}

/* ------------------------------------------------------------------ mint */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `priceShards` is decoded NOWHERE, because mint sends it nowhere.
 *
 * Both decoders below used to read `priceShards` with `toAmount` — the STRICT one, which throws
 * `UsageError` on `undefined` rather than returning null. mint removed the field from the
 * catalogue body and from `toWire` when SHARD was retired on 2026-08-04, and the comment on the
 * catalogue handler in `mint/src/server.ts` says it was removed rather than renamed on purpose:
 * "A removed field is a 'undefined' a client can notice; a silently re-based one is not."
 *
 * The client did not notice. `toAmount(undefined)` throws, so `decodeCatalogue` threw against the
 * DEPLOYED service and `cf mint catalogue` was broken in production from the day mint shipped the
 * removal — see micro-org#227 §1. Nothing went red, because the two repositories' suites were both
 * green and disagreed with each other: `mint/src/server.test.ts` asserts `priceShards` is
 * `undefined` on the catalogue and on a token, while this file's fixtures were written by the
 * decoder's own author and supplied the field the decoder demanded. A fixture that is not the
 * server's real output grades nothing.
 *
 * So the field is GONE here and in `types.ts`, not made optional. A `bigint | undefined` that is
 * `undefined` on every response the estate can produce is a hole with a plausible name over it:
 * it survives a typecheck, autocompletes, and reads as a price. The replacement is
 * `priceUsdCents`, which mint actually sends — strict on the catalogue, where the handler builds
 * it from configuration and it is always present, and tolerant on a token, where the column is
 * null on a row a pre-migration-6 build wrote.
 *
 * The regression test is `the catalogue decodes the body the deployed mint actually returns` in
 * `decode.test.ts`; its fixture is the handler's own body, keys and all, and it is the citation
 * that keeps this honest.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function decodeToken(raw: Raw): Token {
  return {
    ...(raw as unknown as Token),
    supply: toAmount(raw['supply'], 'supply'),
    cap: toAmountOrNull(raw['cap'], 'cap'),
    priceUsdCents: toAmountOrNull(raw['priceUsdCents'], 'priceUsdCents'),
  }
}

export function decodeCatalogue(raw: Raw): MintCatalogue {
  return {
    ...(raw as unknown as MintCatalogue),
    priceUsdCents: toAmount(raw['priceUsdCents'], 'priceUsdCents'),
  }
}

/* ------------------------------------------------------------------ foresight */

export function decodePool(raw: Raw): MarketPool {
  return {
    ...(raw as unknown as MarketPool),
    yes: toAmount(raw['yes'], 'yes'),
    no: toAmount(raw['no'], 'no'),
    total: toAmount(raw['total'], 'total'),
  }
}

export function decodePosition(raw: Raw): MarketPosition {
  const position = (raw['position'] ?? {}) as Raw
  return {
    ...(raw as unknown as MarketPosition),
    position: {
      yes: toAmount(position['yes'], 'position.yes'),
      no: toAmount(position['no'], 'position.no'),
    },
  }
}

/* ------------------------------------------------------------------ worlds */

export function decodeAchievement(raw: Raw): Achievement {
  return {
    ...(raw as unknown as Achievement),
    rewardShards: toAmount(raw['rewardShards'], 'rewardShards'),
  }
}

/* ------------------------------------------------------------------ activity */

export function decodeActivityRecord(raw: Raw): ActivityRecord {
  return {
    ...(raw as unknown as ActivityRecord),
    amount: toAmountOrNull(raw['amount'], 'amount'),
  }
}

/* ------------------------------------------------------------------ helpers */

function asArray(value: unknown): readonly Raw[] {
  return Array.isArray(value) ? (value as Raw[]) : []
}
