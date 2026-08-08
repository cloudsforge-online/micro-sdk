import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeActivityRecord,
  decodeCatalogue,
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
  assert.equal(decodeToken({ supply: '1', cap: null, priceUsdCents: '0' }).cap, null)
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
    priceUsdCents: '2500',
  })
  assert.equal(token.supply, 10n ** 24n)
  assert.equal(token.cap, 2n * 10n ** 24n)
  assert.equal(token.supply.toString(), '1000000000000000000000000')
})

test('a money field that arrives as an unsafe JSON number fails loudly', () => {
  // If a service ever regressed to sending a number, the value in the payload is already not the
  // one it meant. Failing here is the only honest answer.
  assert.throws(() => decodeToken({ supply: 1e30, cap: null, priceUsdCents: '0' }), UsageError)
})

/* ═══════════════════════════════ mint, after SHARD was retired ═══════════════════════════════ */

/**
 * The catalogue body as the DEPLOYED mint service builds it.
 *
 * SOURCE: the `GET /v1/catalogue` handler in `mint/src/server.ts` — the object literal whose first
 * property carries the comment beginning "A decimal STRING, like every amount this service
 * serves" — together with the `VARIANTS` table in `mint/src/catalogue.ts`, which is where
 * `variantFor` gets `contract`, `features` and `cap` from. The handler maps `fixed`, `mintable`
 * and `foundry` in that order and copies exactly those four keys off each spec, so `bytecode` is
 * absent here because it is absent there.
 *
 * The citation names the FILE and the route rather than a line number, deliberately: this
 * repository swept line numbers out of its comments (`refactor: cite the file, never the line`)
 * because a position in a file another repository owns goes stale silently and then fails a build
 * that has nothing to do with it. A route and a quoted sentence survive an edit above them.
 *
 * The point of writing it out rather than reaching for the shape the decoder wanted: this
 * decoder's fixtures used to be written by the decoder's own author and supplied `priceShards`,
 * so they were green for every possible implementation, including the one that threw against the
 * real service. `priceShards` IS NOT PRESENT BELOW, and must never be added — mint stopped sending
 * it on 2026-08-04 and `mint/src/server.test.ts` asserts it is `undefined` on this exact response.
 */
const MINT_CATALOGUE_BODY = Object.freeze({
  priceUsdCents: '2500',
  settlementAsset: 'EMBER',
  network: 'mainnet',
  variants: [
    { variant: 'fixed', contract: 'FixedSupplyToken', features: [], cap: 'forbidden' },
    { variant: 'mintable', contract: 'MintableToken', features: ['mintable', 'burnable'], cap: 'forbidden' },
    {
      variant: 'foundry',
      contract: 'FoundryToken',
      features: ['mintable', 'burnable', 'pausable'],
      cap: 'required',
    },
  ],
})

test('the catalogue decodes the body the deployed mint actually returns', () => {
  // The regression. `decodeCatalogue` read `priceShards` with the STRICT `toAmount`, which throws
  // on `undefined`, so this call raised `UsageError` against every live response mint served after
  // it removed the field — and `cf mint catalogue` was broken in production the whole time.
  const catalogue = decodeCatalogue(MINT_CATALOGUE_BODY)

  assert.equal(catalogue.priceUsdCents, 2_500n)
  assert.equal(typeof catalogue.priceUsdCents, 'bigint')
  assert.equal(catalogue.network, 'mainnet')
  assert.equal(catalogue.variants.length, MINT_CATALOGUE_BODY.variants.length)
  assert.equal(catalogue.variants[2]?.contract, 'FoundryToken')

  // The retired field must not reappear, under any value. `undefined` would be no better than a
  // number: a key that exists reads as a price nobody is quoting.
  assert.equal('priceShards' in catalogue, false)

  // `settlementAsset` is not on `MintCatalogue`, and reaches a caller anyway. That is this SDK's
  // promise about additive fields, and it is what makes removing a field from the type safe.
  assert.equal((catalogue as unknown as Record<string, unknown>)['settlementAsset'], 'EMBER')
})

test('a catalogue with no price at all is still refused, loudly and by name', () => {
  // Dropping `priceShards` must not have loosened the decoder into accepting a priceless
  // catalogue. If mint ever stops sending `priceUsdCents` too, that has to fail here rather than
  // print an empty price — and the message has to name the field, or the next person debugging it
  // learns only that something was missing.
  assert.throws(
    () => decodeCatalogue({ settlementAsset: 'EMBER', network: 'mainnet', variants: [] }),
    (err: unknown) => err instanceof UsageError && /priceUsdCents/.test(err.message),
  )
})

test('a token from before migration 6 decodes with a null price, not a zero one', () => {
  // `toWire` in `mint/src/server.ts` sends `token.priceUsdCents?.toString() ?? null`: the column
  // is null on an order a pre-migration-6 build wrote, and those rows are still in the table. Zero
  // would render a paid order as free, which is the reason this one field is tolerant while the
  // catalogue's is strict.
  const legacy = decodeToken({
    id: 't1',
    status: 'confirmed',
    supply: '1000',
    cap: null,
    priceUsdCents: null,
    chargeAssetCode: 'SHARD',
    chargeAmount: '2500',
  })
  assert.equal(legacy.priceUsdCents, null)
  assert.equal('priceShards' in legacy, false)
  // The charge is reported in the asset the LEDGER records, retired or not. mint says so where it
  // builds this field: printing EMBER over a charge the ledger holds as SHARD would be a false
  // statement about money. The SDK passes it through untouched.
  assert.equal((legacy as unknown as Record<string, unknown>)['chargeAssetCode'], 'SHARD')

  const current = decodeToken({ id: 't2', supply: '1000', cap: null, priceUsdCents: '2500' })
  assert.equal(current.priceUsdCents, 2_500n)
})
