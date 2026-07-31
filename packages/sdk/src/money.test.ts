import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageError } from './errors.ts'
import {
  amountToWire,
  formatAmount,
  parseAmount,
  toAmount,
  toAmountOrNull,
  toSignedAmount,
} from './money.ts'

test('an amount past 2^53 survives the round trip exactly', () => {
  // One EMBER is 10^18 smallest units, so this is 12345.678901234567891234 EMBER — an ordinary
  // balance, and a value a JS number cannot hold. It is the whole reason money is a bigint here.
  const wire = '12345678901234567891234'
  assert.equal(amountToWire(toAmount(wire)), wire)
})

test('a JSON number that is not an exact integer is refused rather than accepted lossily', () => {
  // 2^53 + 1 arrives from JSON.parse as 9007199254740992. The value in the payload is already not
  // the value the sender meant, and accepting it would launder that.
  assert.throws(() => toAmount(2 ** 53 + 1), UsageError)
  assert.throws(() => toAmount(1.5), UsageError)
})

test('a safe-integer JSON number is accepted, matching wallet/src/server.ts:1005', () => {
  assert.equal(toAmount(100), 100n)
  assert.equal(toAmount(0), 0n)
})

test('a negative, a float string and a separator are all refused', () => {
  for (const bad of ['-1', '1.5', '1_000', '1e18', '', ' ', '0x10']) {
    assert.throws(() => toAmount(bad), UsageError, `expected ${JSON.stringify(bad)} to be refused`)
  }
})

test('toAmountOrNull keeps null null, so a nullable price does not become zero', () => {
  assert.equal(toAmountOrNull(null), null)
  assert.equal(toAmountOrNull(undefined), null)
  assert.equal(toAmountOrNull('7'), 7n)
})

test('toSignedAmount carries the sign; toAmount refuses it', () => {
  // netObserved is confirmed-in minus confirmed-out and is the one public field that can be
  // negative. Dropping the sign would render an outflow as an inflow.
  assert.equal(toSignedAmount('-500'), -500n)
  assert.equal(toSignedAmount('500'), 500n)
  assert.throws(() => toAmount('-500'), UsageError)
})

test('amountToWire refuses a negative amount before it reaches the wire', () => {
  assert.throws(() => amountToWire(-1n), UsageError)
})

test('formatAmount is exact where a float divide is not', () => {
  // 0.1 + 0.2 !== 0.3 is the shape of this failure at 18 decimals.
  assert.equal(formatAmount(100000000000000000n, 18), '0.1')
  assert.equal(formatAmount(1n, 18), '0.000000000000000001')
  assert.equal(formatAmount(1000000000000000000n, 18), '1')
  assert.equal(formatAmount(12345678901234567891234n, 18), '12345.678901234567891234')
  assert.equal(formatAmount(0n, 18), '0')
  assert.equal(formatAmount(-1500n, 3), '-1.5')
  // Shards have no decimals; the string is the integer.
  assert.equal(formatAmount(42n, 0), '42')
})

test('formatAmount and parseAmount round-trip at every supported scale', () => {
  for (const decimals of [0, 6, 8, 9, 18]) {
    for (const units of [0n, 1n, 999n, 10n ** 24n + 7n]) {
      assert.equal(parseAmount(formatAmount(units, decimals), decimals), units)
    }
  }
})

test('parseAmount refuses more precision than the asset has, rather than rounding it away', () => {
  // BTC has 8 decimals. Rounding 0.000000005 to 0.00000001 or to 0 both spend somebody else's
  // money without asking, so neither is on offer.
  assert.throws(() => parseAmount('0.000000005', 8), UsageError)
  assert.equal(parseAmount('0.00000001', 8), 1n)
})

test('parseAmount refuses anything that is not a decimal', () => {
  for (const bad of ['', 'abc', '1e5', '1,5', '--1', '1.']) {
    assert.throws(() => parseAmount(bad, 8), UsageError, `expected ${JSON.stringify(bad)} to be refused`)
  }
})

test('an out-of-range decimals is a usage error, not a silent 10 ** NaN', () => {
  assert.throws(() => formatAmount(1n, -1), UsageError)
  assert.throws(() => formatAmount(1n, 1.5), UsageError)
  assert.throws(() => parseAmount('1', 99), UsageError)
})
