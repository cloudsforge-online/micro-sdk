import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
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
import { formatAmount } from './money.ts'

/**
 * These values are DUPLICATED from `@cloudsforge/contracts-chain` — see the header of `chain.ts`
 * for why a public package cannot depend on a private one, and `tools/drift.ts` for the check that
 * compares this file against the real source.
 *
 * The tests below are the half that runs everywhere, including from the published tarball where
 * there is no micro-contracts to compare against. They assert the values themselves, so a careless
 * edit here fails locally rather than waiting for CI to reach the sibling checkout.
 */

test('the values that must agree byte-for-byte with contracts-chain', () => {
  assert.equal(RATE_SCALE, 1_000_000n)
  assert.equal(SHARDS_PER_USD, 100n)
  assert.equal(10n ** BigInt(RATE_SCALE_DECIMALS), RATE_SCALE)

  assert.equal(ASSETS.EMBER.decimals, 18)
  assert.equal(ASSETS.ETH.decimals, 18)
  assert.equal(ASSETS.ETC.decimals, 18)
  assert.equal(ASSETS.BTC.decimals, 8)
  assert.equal(ASSETS.LTC.decimals, 8)
  assert.equal(ASSETS.DOGE.decimals, 8)
  assert.equal(ASSETS.SOL.decimals, 9)
  assert.equal(ASSETS.XRP.decimals, 6)
  assert.equal(ASSETS.SHARD.decimals, 0)

  // A confirmation depth is not a preference. Crediting at the wrong one is money credited on a
  // block that can still be reorganised away.
  assert.equal(ASSETS.EMBER.confirmations, 60)
  assert.equal(ASSETS.ETH.confirmations, 12)
  // SIX. This assertion said 3 and passed for as long as it did, which is the point worth
  // recording: `chain.test.ts` can only assert that this file agrees with ITSELF. The upstream had
  // said 6 since native deposits were built, `tools/drift.ts` was printing the disagreement, and no
  // CI job was failing on it — so the published SDK told integrators a Bitcoin deposit was final
  // about half an hour before the platform would credit it.
  assert.equal(ASSETS.BTC.confirmations, 6)
  // TWELVE, and deliberately not Bitcoin's six despite the shared family: ~2.5-minute blocks on a
  // fraction of the hashrate. A depth belongs to a chain's security budget, not to the software
  // that follows it.
  assert.equal(ASSETS.LTC.confirmations, 12)
  assert.equal(ASSETS.LTC.family, ASSETS.BTC.family)
  assert.notEqual(ASSETS.LTC.confirmations, ASSETS.BTC.confirmations)
  // THIRTY, and the number to beware of here was Litecoin's rather than Bitcoin's: ~63.4s blocks
  // make thirty confirmations ~31.7 minutes, the wall clock LTC's twelve buys. The `notEqual` is
  // the same guard LTC carries against BTC, aimed at the same reflex one family further along.
  assert.equal(ASSETS.DOGE.confirmations, 30)
  assert.equal(ASSETS.DOGE.family, ASSETS.LTC.family)
  assert.notEqual(ASSETS.DOGE.confirmations, ASSETS.LTC.confirmations)
  // SEVEN THOUSAND FIVE HUNDRED — ~28 hours, and the deepest depth this SDK publishes by three
  // orders of magnitude. It is pinned here because a number that large reads like a typo to the
  // next person editing this table, and quietly "correcting" it to ETH's twelve would tell an
  // integration a deposit is final 2.7 minutes into a chain whose reorganisations have run to
  // ~7,000 blocks. Same family as ETH, and deliberately nothing like its depth.
  assert.equal(ASSETS.ETC.confirmations, 7500)
  assert.equal(ASSETS.ETC.family, ASSETS.ETH.family)
  assert.notEqual(ASSETS.ETC.confirmations, ASSETS.ETH.confirmations)
  assert.equal(ASSETS.SOL.confirmations, 32)
  assert.equal(ASSETS.XRP.confirmations, 1)
  assert.equal(ASSETS.SHARD.confirmations, 0)
})

test('Shards are not an on-chain asset, and the record is still total', () => {
  assert.deepEqual([...ON_CHAIN_ASSETS], ['EMBER', 'BTC', 'ETH', 'ETC', 'LTC', 'DOGE', 'SOL', 'XRP'])
  assert.equal(ON_CHAIN_ASSETS.includes('SHARD'), false)
  // Total: every code has a spec, so a lookup can never be undefined under
  // noUncheckedIndexedAccess.
  for (const code of ASSET_CODES) assert.equal(assetSpec(code).asset, code)
  assert.deepEqual([...ASSET_CODES].sort(), Object.keys(ASSETS).sort())
})

test('isConfirmed credits AT the depth, not one block after it', () => {
  assert.equal(isConfirmed('BTC', 5), false)
  assert.equal(isConfirmed('BTC', 6), true)
  // The old numbers, kept as the negative case: 3 was this SDK's answer and it was WRONG, so a
  // client that still credits there is crediting three blocks early.
  assert.equal(isConfirmed('BTC', 3), false)
  assert.equal(isConfirmed('LTC', 11), false)
  assert.equal(isConfirmed('LTC', 12), true)
  assert.equal(isConfirmed('DOGE', 29), false)
  assert.equal(isConfirmed('DOGE', 30), true)
  // Litecoin's depth on Dogecoin, kept as the negative case for the same reason BTC's 3 is: it is
  // the number an integration reaches for when it sees the shared family, and at ~63.4s blocks it
  // credits after 12.7 minutes rather than the ~31.7 the platform waits.
  assert.equal(isConfirmed('DOGE', 12), false)
  // And Ethereum's depth on Ethereum Classic, which is 2.7 minutes into a chain that has
  // reorganised past 7,000 blocks.
  assert.equal(isConfirmed('ETC', 12), false)
  assert.equal(isConfirmed('ETC', 7499), false)
  assert.equal(isConfirmed('ETC', 7500), true)
  assert.equal(isConfirmed('EMBER', 59), false)
  assert.equal(isConfirmed('EMBER', 60), true)
  // Shards have no chain, so nothing is ever unconfirmed.
  assert.equal(isConfirmed('SHARD', 0), true)
})

test('an unknown asset is a RangeError rather than an undefined spec', () => {
  // `NOTACHAIN`, AND NOT A REAL TICKER. This test said `DOGE` until Dogecoin was added, at which
  // point the call it asserts throws started succeeding — it failed loudly only because the
  // assertion happens to be `assert.throws`, and the `isAssetCode` line below it would have gone
  // on passing while asserting the opposite of the truth. Upstream met the same trap in the same
  // week and made the same repair. A ticker the platform might one day support is a fixture with
  // an expiry date on it, and there are more assets queued behind these two.
  assert.throws(() => assetSpec('NOTACHAIN' as never), RangeError)
  assert.equal(isAssetCode('NOTACHAIN'), false)
  assert.equal(isAssetCode('EMBER'), true)
  assert.equal(isAssetCode('DOGE'), true)
  assert.equal(isAssetCode('ETC'), true)
  // Case matters: the services upper-case before matching, and a lower-case code is not a code.
  assert.equal(isAssetCode('ember'), false)
})

test('a scaled rate renders with RATE_SCALE_DECIMALS, not with a float divide', () => {
  // 0.25 USD at RATE_SCALE. Number(250000) / 1e6 happens to be exact here and is not for
  // 1/3-shaped values, which is why the constant exists at all.
  assert.equal(formatAmount(250_000n, RATE_SCALE_DECIMALS), '0.25')
  assert.equal(formatAmount(1n, RATE_SCALE_DECIMALS), '0.000001')
})

test('decimalsFor is the accessor a caller needs to render any balance', () => {
  assert.equal(decimalsFor('EMBER'), 18)
  assert.equal(formatAmount(10n ** 18n, decimalsFor('EMBER')), '1')
  assert.equal(formatAmount(100_000_000n, decimalsFor('BTC')), '1')
})

test('the tables are frozen, so a consumer cannot mutate another consumer’s constants', () => {
  assert.equal(Object.isFrozen(ASSETS), true)
  assert.equal(Object.isFrozen(ASSETS.EMBER), true)
  assert.equal(Object.isFrozen(ON_CHAIN_ASSETS), true)
})
