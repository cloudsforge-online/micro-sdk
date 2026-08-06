import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeActivityRecord,
  decodeListing,
  decodeObservedWallet,
  decodeOrder,
  decodePortfolio,
  decodeRate,
  decodeToken,
  decodeWithdrawal,
} from './decode.ts'
import { UsageError } from './errors.ts'

test('a field the platform adds tomorrow survives a decoder written today', () => {
  // The public API's promise is that additive changes need no version. That only holds if the
  // client does not strip what it does not recognise — a decoder that rebuilt the object field by
  // field would silently discard every additive change and the caller could not tell.
  const decoded = decodeListing({
    id: 'l1',
    quantity: '3',
    price: '500',
    somethingAddedLater: 'kept',
  }) as unknown as Record<string, unknown>
  assert.equal(decoded['somethingAddedLater'], 'kept')
  assert.equal(decoded['quantity'], 3n)
})

test('every money field on an order becomes a bigint', () => {
  const order = decodeOrder({
    id: 'o1',
    quantity: '2',
    amount: '1000',
    feeAmount: '25',
    royaltyAmount: '50',
    sellerProceeds: '925',
    royalties: [{ subject: 'user:1', amount: '50' }],
  })
  assert.equal(order.amount, 1000n)
  assert.equal(order.feeAmount, 25n)
  assert.equal(order.royaltyAmount, 50n)
  assert.equal(order.sellerProceeds, 925n)
  assert.equal(order.quantity, 2n)
  assert.equal(order.royalties[0]?.amount, 50n)
  // The arithmetic the seller cares about, done exactly.
  assert.equal(order.amount - order.feeAmount - order.royaltyAmount, order.sellerProceeds)
})

test('a null price stays null and does not become zero', () => {
  // An auction listing has no fixed price. Zero would render as free.
  assert.equal(decodeListing({ id: 'l1', quantity: '1', price: null }).price, null)
  assert.equal(decodeToken({ supply: '1', cap: null, priceShards: '0' }).cap, null)
  assert.equal(decodeActivityRecord({ id: 'a1', amount: null }).amount, null)
})

test('an unusable rate decodes with nulls rather than throwing', () => {
  // pricing/src/server.ts answers 200 with usable:false and every price null. A decoder that
  // demanded a number there would turn "we have no quote" into a client-side crash.
  const rate = decodeRate({
    asset: 'EMBER',
    usable: false,
    reason: 'no administered price set',
    usdScaled: null,
    usdSellScaled: null,
    usdBuyScaled: null,
    shardsPerCoinSellScaled: null,
    shardsPerCoinBuyScaled: null,
    rateScale: '1000000',
  })
  assert.equal(rate.usable, false)
  assert.equal(rate.usdScaled, null)
  assert.equal(rate.rateScale, 1_000_000n)
})

test('netObserved keeps its sign; every other money field refuses one', () => {
  const outflow = decodeObservedWallet({ walletId: 'w1', netObserved: '-2500', balance: null })
  assert.equal(outflow.netObserved, -2500n)
  // balance is ALWAYS null: the indexer exposes no balance read. Substituting netObserved would
  // render a movement as a holding.
  assert.equal(outflow.balance, null)
  assert.throws(() => decodeWithdrawal({ amount: '-1', fee: '0', net: '0' }), UsageError)
})

test('a portfolio decodes its balances and its wallets, and keeps degraded', () => {
  const portfolio = decodePortfolio({
    subject: 'user:1',
    balances: [
      {
        assetCode: 'SHARD',
        amount: '12345',
        valuation: { usdScaled: '123450', quotedAt: '2026-07-31T00:00:00Z', source: 'market' },
      },
      { assetCode: 'BTC', amount: '100000000', valuation: null },
    ],
    wallets: [{ walletId: 'w1', netObserved: '0', balance: null }],
    degraded: ['indexer'],
    nextCursor: null,
  })
  assert.equal(portfolio.balances[0]?.amount, 12345n)
  assert.equal(portfolio.balances[0]?.valuation?.usdScaled, 123450n)
  // A holding with no price is shown, not hidden.
  assert.equal(portfolio.balances[1]?.valuation, null)
  assert.deepEqual([...portfolio.degraded], ['indexer'])
})

test('a portfolio with no balances array decodes to an empty one rather than throwing', () => {
  // Defensive: a degraded response is still worth showing, and a decoder that threw on a missing
  // array would take the whole page down over one absent field.
  const portfolio = decodePortfolio({ subject: 'user:1', degraded: [], nextCursor: null })
  assert.deepEqual([...portfolio.balances], [])
  assert.deepEqual([...portfolio.wallets], [])
})

test('a supply of 10^24 survives, which is the reason none of this is a number', () => {
  const token = decodeToken({
    supply: '1000000000000000000000000',
    cap: '2000000000000000000000000',
    priceShards: '500',
  })
  assert.equal(token.supply, 10n ** 24n)
  assert.equal(token.cap, 2n * 10n ** 24n)
  assert.equal(token.supply.toString(), '1000000000000000000000000')
})

test('a money field that arrives as an unsafe JSON number fails loudly', () => {
  // If a service ever regressed to sending a number, the value in the payload is already not the
  // one it meant. Failing here is the only honest answer.
  assert.throws(() => decodeToken({ supply: 1e30, cap: null, priceShards: '0' }), UsageError)
})
