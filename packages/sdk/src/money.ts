/**
 * Money.
 *
 * TWO RULES, and everything here is one of them:
 *
 * 1. **An amount is a `bigint` in the smallest unit.** Never a `number`. An 18-decimal EMBER
 *    balance passes 2^53 at 0.009 EMBER, and a JS number silently stops being the value the caller
 *    meant somewhere around there. `wallet/src/server.ts:995` refuses a JSON number that is not
 *    already a safe integer for exactly this reason, and says so in the error.
 * 2. **It crosses the wire as a decimal string.** `JSON.stringify` throws on a bigint, so the
 *    conversion is not optional; doing it in one place is what stops it being done differently in
 *    eleven.
 *
 * A float anywhere near an amount is a defect. There is no `number` in this file's public surface
 * except `decimals`, which is a count of digits and not a quantity.
 */

import { UsageError } from './errors.ts'

/** Smallest-unit amount, decimal, no sign, no separators. What the services accept and return. */
const AMOUNT = /^\d+$/

/**
 * Parse a smallest-unit amount off the wire.
 *
 * Accepts a string, and a `number` ONLY when it is already a safe integer — mirroring
 * `requireAmount` at `wallet/src/server.ts:1003`. Beyond that the value has already lost precision
 * before this code ran, and the honest answer is to refuse it rather than act on a number that is
 * quietly not the one the server sent.
 */
export function toAmount(value: unknown, field = 'amount'): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new UsageError(
        `${field} arrived as the JSON number ${value}, which is not an exact integer; ` +
          'it had already lost precision before this SDK saw it',
      )
    }
    return BigInt(value)
  }
  if (typeof value === 'string' && AMOUNT.test(value.trim())) return BigInt(value.trim())
  throw new UsageError(
    `${field} must be a non-negative integer in smallest units, as a decimal string (got ${describe(value)})`,
  )
}

/** The same, but `null` survives as `null` — a great many fields are nullable amounts. */
export function toAmountOrNull(value: unknown, field = 'amount'): bigint | null {
  return value === null || value === undefined ? null : toAmount(value, field)
}

/**
 * A movement rather than a holding: it may be negative.
 *
 * Separate from `toAmount` on purpose. A balance, a price and a fee are non-negative by
 * construction and a minus sign on one of them is a bug worth a loud failure; `netObserved`
 * (confirmed in minus confirmed out) is the one public field where the sign is the information.
 * Loosening `toAmount` to accept a sign everywhere would trade that signal away for one field.
 */
export function toSignedAmount(value: unknown, field = 'amount'): bigint {
  if (typeof value === 'string' && value.trim().startsWith('-')) {
    return -toAmount(value.trim().slice(1), field)
  }
  if (typeof value === 'number' && value < 0) {
    if (!Number.isSafeInteger(value)) {
      throw new UsageError(
        `${field} arrived as the JSON number ${value}, which is not an exact integer; ` +
          'it had already lost precision before this SDK saw it',
      )
    }
    return BigInt(value)
  }
  return toAmount(value, field)
}

/** Put an amount on the wire. The single place a bigint becomes JSON. */
export function amountToWire(value: bigint, field = 'amount'): string {
  if (value < 0n) throw new UsageError(`${field} must not be negative (got ${value})`)
  return value.toString()
}

/**
 * A human-readable amount: smallest units and a decimal count to a decimal string.
 *
 * All integer arithmetic. `Number(units) / 10 ** decimals` is the one-liner this exists to replace
 * and it is wrong for any balance a real user has.
 *
 * Duplicated from `@cloudsforge/contracts-chain`'s `formatAmount` — see `chain.ts` for why this
 * package duplicates rather than depends, and `tools/drift.ts` for the check that keeps the two
 * honest.
 */
export function formatAmount(smallestUnits: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new UsageError(`decimals must be an integer between 0 and 36 (got ${decimals})`)
  }
  if (decimals === 0) return smallestUnits.toString()
  const negative = smallestUnits < 0n
  const magnitude = negative ? -smallestUnits : smallestUnits
  const scale = 10n ** BigInt(decimals)
  const whole = magnitude / scale
  const fraction = (magnitude % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`
}

/**
 * The inverse: a decimal string to smallest units, exactly.
 *
 * Refuses more fractional digits than the asset has rather than rounding. Rounding here is how a
 * user asks to send 1.0000000000000000005 EMBER and is charged for 1.000000000000000001.
 */
export function parseAmount(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new UsageError(`decimals must be an integer between 0 and 36 (got ${decimals})`)
  }
  const trimmed = text.trim()
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new UsageError(`not a decimal amount: ${text}`)
  }
  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = '0', fraction = ''] = unsigned.split('.')
  if (fraction.length > decimals) {
    throw new UsageError(
      `${text} has ${fraction.length} decimal places but this asset has ${decimals}; ` +
        'refusing rather than rounding somebody else’s money',
    )
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  return negative ? -units : units
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}
