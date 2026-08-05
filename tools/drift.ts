/**
 * The drift check: does `packages/sdk/src/chain.ts` still agree with the private contracts package
 * it was copied from?
 *
 *     pnpm drift --contracts ../contracts
 *     pnpm drift                              # finds a sibling checkout automatically
 *
 * ## Why this is a script and not a test
 *
 * `pnpm test` must pass for a stranger holding only the published tarball. A stranger has no
 * access to the private contracts repository, so a test that read it could only skip — and a
 * skipped test is an unmeasured one, which `docs/ecosystem/17-definition-of-done.md` §9 refuses by
 * name. So the invariant is split: `chain.test.ts` asserts the VALUES and runs everywhere, and this
 * script asserts they still match their SOURCE and runs in CI, where the sibling checkout exists.
 *
 * ## Why it exists at all
 *
 * `chain.ts` duplicates values the estate exact-pins precisely because a skew in them is not a 500
 * — it is money credited at the wrong depth. Duplicating something with that property is only
 * defensible with a check. This is the check.
 *
 * It reads the upstream source TEXT rather than importing it, deliberately: importing would mean
 * resolving a private workspace from a public repository, which is the dependency this package
 * exists to not have. A regex over a frozen literal table is crude, and it is crude in the safe
 * direction — an upstream refactor that this cannot parse fails loudly rather than passing
 * silently.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASSETS,
  ASSET_CODES,
  ON_CHAIN_ASSETS,
  RATE_SCALE,
  SHARDS_PER_USD,
  type AssetCode,
} from '../packages/sdk/src/chain.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/** Where a sibling checkout usually is, in the order CI and a developer's machine put it. */
const CANDIDATES = [
  process.env['CLOUDSFORGE_CONTRACTS_DIR'],
  path.resolve(repoRoot, '..', 'contracts'),
  path.resolve(repoRoot, '.contracts'),
]

interface Upstream {
  readonly path: string
  readonly text: string
}

function locate(argv: readonly string[]): Upstream {
  const flagAt = argv.indexOf('--contracts')
  const explicit = flagAt === -1 ? undefined : argv[flagAt + 1]
  const roots = [explicit, ...CANDIDATES].filter((value): value is string => Boolean(value))

  for (const root of roots) {
    const file = path.join(root, 'packages', 'chain', 'src', 'index.ts')
    if (existsSync(file)) return { path: file, text: readFileSync(file, 'utf8') }
  }
  throw new Error(
    'could not find the contracts source. Pass --contracts <dir>, set CLOUDSFORGE_CONTRACTS_DIR,\n' +
      `or place a checkout next to this repository. Looked in:\n${roots.map((r) => `  ${r}`).join('\n')}`,
  )
}

/** `RATE_SCALE = 1_000_000n` → 1000000n, with underscores removed. */
function bigintConstant(text: string, name: string): bigint {
  const match = new RegExp(`export const ${name} = ([0-9_]+)n`).exec(text)
  if (!match?.[1]) throw new Error(`could not read ${name} from the upstream source`)
  return BigInt(match[1].replace(/_/g, ''))
}

/** The `decimals:` and `confirmations:` of one entry in the frozen CHAINS table. */
function assetFacts(text: string, asset: AssetCode): { decimals: number; confirmations: number } {
  const entry = new RegExp(
    `${asset}: Object\\.freeze\\(\\{[\\s\\S]*?asset: '${asset}'[\\s\\S]*?\\}\\),\\n`,
  ).exec(text)
  if (!entry?.[0]) throw new Error(`could not find ${asset} in the upstream CHAINS table`)
  const decimals = /decimals: (\d+)/.exec(entry[0])
  const confirmations = /confirmations: (\d+)/.exec(entry[0])
  if (!decimals?.[1] || !confirmations?.[1]) {
    throw new Error(`could not read decimals/confirmations for ${asset}`)
  }
  return { decimals: Number(decimals[1]), confirmations: Number(confirmations[1]) }
}

/**
 * The upstream `AssetCode` union, as a set of codes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES, AND WHAT IT COST.
 *
 * Until 2026-08-05 this script compared VALUES for the assets THIS SDK already knew — it looped
 * `ASSET_CODES`, ours, and looked each one up upstream. So it could tell you that our BTC depth
 * disagreed, but it was structurally incapable of telling you that upstream had an asset we did
 * not. Litecoin sat in the upstream `CHAINS` table for two phases and this check had nothing to
 * say about it, because it never asked a question whose answer could have been "there is a sixth".
 *
 * That is the more dangerous half of a drift check: an incomplete copy looks exactly like a
 * correct one from the inside. A consumer calling `assetSpec('LTC')` got a type error and
 * concluded the platform does not support Litecoin — which the platform's own custody, settlement
 * and wallet services would have disagreed with.
 *
 * So both directions are now compared, as SETS: an asset upstream has and we lack, and an asset we
 * have and upstream does not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function upstreamAssetCodes(text: string): readonly string[] {
  const match = /export type AssetCode = ([^\n]+)/.exec(text)
  if (!match?.[1]) throw new Error('could not read the upstream AssetCode union')
  const codes = [...match[1].matchAll(/'([A-Z]+)'/g)].map((m) => m[1] as string)
  if (codes.length === 0) throw new Error('the upstream AssetCode union parsed to nothing')
  return codes
}

/** The upstream `ON_CHAIN_ASSETS` array literal. Same regex shape micro-site's claims test uses. */
function upstreamOnChainAssets(text: string): readonly string[] {
  const match = /ON_CHAIN_ASSETS:[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(text)
  if (!match?.[1]) throw new Error('upstream ON_CHAIN_ASSETS is no longer a frozen array literal')
  const codes = [...match[1].matchAll(/'([A-Z]+)'/g)].map((m) => m[1] as string)
  if (codes.length === 0) throw new Error('upstream ON_CHAIN_ASSETS parsed to nothing')
  return codes
}

function main(argv: readonly string[]): number {
  let upstream: Upstream
  try {
    upstream = locate(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  const findings: string[] = []
  const compare = (what: string, ours: unknown, theirs: unknown): void => {
    if (String(ours) !== String(theirs)) {
      findings.push(`${what}: this SDK says ${String(ours)}, the contract says ${String(theirs)}`)
    }
  }

  /** Set difference, reported in both directions so neither a missing nor an extra asset hides. */
  const compareSets = (what: string, ours: readonly string[], theirs: readonly string[]): void => {
    const missing = theirs.filter((code) => !ours.includes(code))
    const extra = ours.filter((code) => !theirs.includes(code))
    if (missing.length > 0) {
      findings.push(`${what}: the contract has ${missing.join(', ')} and this SDK does not`)
    }
    if (extra.length > 0) {
      findings.push(`${what}: this SDK has ${extra.join(', ')} and the contract does not`)
    }
  }

  try {
    compare('RATE_SCALE', RATE_SCALE, bigintConstant(upstream.text, 'RATE_SCALE'))
    compare('SHARDS_PER_USD', SHARDS_PER_USD, bigintConstant(upstream.text, 'SHARDS_PER_USD'))
    // The SETS first: an asset upstream has and we lack would otherwise be invisible to every
    // comparison below, because those all iterate OUR list.
    compareSets('AssetCode', ASSET_CODES, upstreamAssetCodes(upstream.text))
    compareSets('ON_CHAIN_ASSETS', ON_CHAIN_ASSETS, upstreamOnChainAssets(upstream.text))
    for (const asset of ASSET_CODES) {
      const theirs = assetFacts(upstream.text, asset)
      compare(`${asset}.decimals`, ASSETS[asset].decimals, theirs.decimals)
      compare(`${asset}.confirmations`, ASSETS[asset].confirmations, theirs.confirmations)
    }
  } catch (err) {
    // An upstream refactor this cannot parse is a failure, not a pass. A drift check that silently
    // stops checking is worse than none, because it looks like evidence.
    process.stderr.write(
      `drift: could not read the upstream source at ${upstream.path}\n` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        'Update tools/drift.ts to match the new shape, then re-run.\n',
    )
    return 1
  }

  if (findings.length > 0) {
    process.stderr.write(
      `drift: packages/sdk/src/chain.ts disagrees with ${upstream.path}\n` +
        `${findings.map((finding) => `  ${finding}`).join('\n')}\n\n` +
        'A skew in these values is not a 500. It is money credited at the wrong depth, or an\n' +
        'amount rendered at the wrong scale in every integration built on this SDK. Fix chain.ts,\n' +
        'and treat the change as breaking if a consumer could have relied on the old value.\n',
    )
    return 1
  }

  process.stdout.write(
    `drift: ok — ${ASSET_CODES.length} assets, RATE_SCALE and SHARDS_PER_USD all agree with ${upstream.path}\n`,
  )
  return 0
}

process.exitCode = main(process.argv.slice(2))
