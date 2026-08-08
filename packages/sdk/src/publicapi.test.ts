/**
 * The public API's two derived artefacts stay derived.
 *
 * `docs/ecosystem/11-data-and-contract-strategy.md`:288 says the public API's OpenAPI description
 * is "published, used to generate `@cloudsforge/sdk`". No such description existed anywhere in the
 * estate — the named mechanism had no artefact — and the gateway had no public route map either,
 * so there was no public API to describe. Both are now generated from the one table that was
 * verified route by route against the services that serve them.
 *
 * The direction is inverted from what 11 assumed, deliberately: OpenAPI is generated FROM the
 * verified table, not the table from OpenAPI. There was no description to generate from, and a
 * citation into a serving line is stronger evidence than a document nobody has re-read.
 *
 * These tests exist because this estate has twice shipped a document that described something
 * other than reality — a brand manifest whose checksums were taken before the files were rewritten,
 * and a "Reproduce:" line naming a validator that had never existed. A generated artefact that
 * nobody checks is the same defect with better provenance.
 *
 * ## Why the gateway map is not read here
 *
 * It lives in micro-deploy, which is private and which a stranger holding the published tarball
 * does not have. A test that read it could only skip, and `tools/drift.ts` already refuses that
 * trade in its header: an invariant needing a sibling checkout belongs in a CI job. Reading it
 * anyway is what made run 30691403652 red, on correct code.
 *
 * So the split is the same one drift.ts draws. `.github/workflows/ci.yml`'s `gateway` job checks
 * micro-deploy out and grades the REAL map — and then deletes a router from it and demands the
 * check go red, so the job cannot pass by reading nothing. What is left here is the half that runs
 * everywhere, plus proof that the checker the job runs is capable of failing at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from './routes.ts'

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))

/** The generator, as CI invokes it. Returns stdout+stderr and the exit code, never throwing. */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', root('tools/public-api.ts'), ...args],
      { encoding: 'utf8', cwd: root('.'), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('the generator reports the description in sync', () => {
  // The single source of truth for "is openapi.json stale" — the same command CI runs.
  const { code, out } = run('--check')
  assert.equal(code, 0, out)
  assert.match(out, /openapi in sync/)
})

test('--check cannot claim the gateway map was checked, because it did not read it', () => {
  // The anti-vacuity assertion for the split itself. CI's gateway job greps stdout for the phrase
  // below; if `--check` ever printed it, that job would pass while reading nothing, and the defect
  // would be invisible exactly the way it was invisible before run 30691403652.
  const { out } = run('--check')
  assert.doesNotMatch(out, /every resource routed/)
})

test('a gateway map that is not there is a failure, never a pass', () => {
  const { code, out } = run('--gateway', join(tmpdir(), 'cf-no-such-deploy-checkout'))
  assert.equal(code, 1, 'a missing map must be exit 1 — the whole reason this test exists')
  assert.match(out, /contains no/)
  assert.doesNotMatch(out, /every resource routed/)
})

/**
 * A synthetic micro-deploy checkout whose map routes exactly the resources named.
 *
 * The resource list is re-derived here from ROUTES rather than imported from the generator, on
 * purpose: two independent derivations disagreeing is a finding, and a test that borrows the
 * subject's own arithmetic can only ever confirm it.
 */
function deployCheckout(routers: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-deploy-'))
  mkdirSync(join(dir, 'gateway', 'dynamic'), { recursive: true })
  const rules = routers
    .map((r) => `      rule: "Host(\`api.example\`) && PathPrefix(\`/v1/${r}\`)"`)
    .join('\n')
  writeFileSync(join(dir, 'gateway', 'dynamic', 'public-api.yml'), `http:\n  routers:\n${rules}\n`)
  return dir
}

/** Every top-level resource segment the public surface exposes, derived from the table alone. */
const RESOURCES = [
  ...new Set(
    Object.values(ROUTES).map((r) => {
      const publicPath = r.path.startsWith('/v1/') ? r.path : `/v1${r.path}`
      return publicPath.split('/').filter(Boolean)[1] ?? ''
    }),
  ),
].sort()

test('the gateway check passes a map that routes every resource', () => {
  const { code, out } = run('--gateway', deployCheckout(RESOURCES))
  assert.equal(code, 0, out)
  assert.match(out, /every resource routed/)
})

test('and fails the moment one router is missing — the checker can say no', () => {
  // An assertion that the checker returns "all good" proves nothing unless the checker can say
  // otherwise. Without this, `gatewayGaps` could return [] unconditionally and every other test
  // here would stay green.
  for (const dropped of RESOURCES) {
    const { code, out } = run('--gateway', deployCheckout(RESOURCES.filter((r) => r !== dropped)))
    assert.equal(code, 1, `dropping /v1/${dropped} must fail the check, and did not:\n${out}`)
    assert.match(out, new RegExp(`/v1/${dropped} is not routed`))
  }
})

test('a router that exists only in a comment does not count as routed', () => {
  // This was a live bug: the generated map's header explains the layout using `/v1/rates` as its
  // example, so removing the real router left the checker matching the PROSE and reporting
  // everything routed. Six guards in this estate have confused a rule with a sentence about one;
  // this is the only one that made a check too permissive rather than too strict.
  const dir = deployCheckout(RESOURCES.filter((r) => r !== 'rates'))
  const file = join(dir, 'gateway', 'dynamic', 'public-api.yml')
  writeFileSync(
    file,
    `# The public path is api/v1/<resource>, e.g. PathPrefix(\`/v1/rates\`).\n${readFileSync(file, 'utf8')}`,
  )
  const { code, out } = run('--gateway', dir)
  assert.equal(code, 1, 'the header sentence must not satisfy the router requirement')
  assert.match(out, /\/v1\/rates is not routed/)
})

test('every operation in the description cites the file that serves it', () => {
  // This asserted `:\d+` — a citation with a LINE — until `refactor: cite the file, never the
  // line` stripped the line numbers out of openapi.json on the owner's instruction and left this
  // test, and `--check`, disagreeing with the artefact. main has been red since.
  //
  // The requirement is unchanged in what it protects: an operation must still carry a citation a
  // reader can go and check, because a description nobody can re-check is a claim. Only the
  // granularity moved, and it moved because a position inside a repository this one does not own
  // goes stale silently and then fails a build that has nothing to do with it.
  //
  // That the citation is the RIGHT file is not asserted here and does not need to be: the first
  // test in this file runs `--check`, which regenerates every description from `routes.ts` and
  // compares it to the committed document byte for byte. What is left for this test is the part
  // `--check` cannot see, because it would compare a wrong rule against itself and agree — that
  // the shape the generator emits is a citation at all, and that it is a file rather than a line.
  const doc = JSON.parse(readFileSync(root('openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, { description?: string; operationId?: string }>>
  }
  const ops = Object.values(doc.paths).flatMap((ms) => Object.values(ms))
  assert.equal(ops.length, Object.keys(ROUTES).length, 'every route must appear exactly once')
  for (const op of ops) {
    assert.match(
      op.description ?? '',
      /Verified against `[a-z][a-z-]*\/src\/[a-z0-9.]+\.ts`/,
      `${op.operationId} has no citation — a description nobody can re-check is a claim`,
    )
    // …and no line is published with it. The line survives in `routes.ts`, which is internal and
    // is repointed by hand; what leaves the repository is the file.
    assert.doesNotMatch(op.description ?? '', /\.ts:\d+/)
  }
})

test('the described surface is uniformly versioned, which the services are not', () => {
  // Four services serve /v1 and four do not. The gateway makes that invisible; if the description
  // leaked the split, a third party would learn which resources happen to share a service.
  const doc = JSON.parse(readFileSync(root('openapi.json'), 'utf8')) as { paths: Record<string, unknown> }
  for (const p of Object.keys(doc.paths)) {
    assert.ok(p.startsWith('/v1/'), `${p} is not versioned — the public surface must be uniform`)
  }
})

test('an unauthenticated route declares no security, so no client sends it a token', () => {
  // This is the market-policy defect encoded as a document. 24 of the estate's public routes make
  // no authenticate() call; sending a token to one is how a client ends up reasoning about a 403
  // that was never about authorisation.
  const doc = JSON.parse(readFileSync(root('openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>
  }
  for (const [, ms] of Object.entries(doc.paths)) {
    for (const [, op] of Object.entries(ms)) {
      const spec = ROUTES[op.operationId as keyof typeof ROUTES]
      if (spec.auth === 'none') {
        assert.deepEqual(op.security, [], `${op.operationId} is unauthenticated but declares security`)
      } else {
        assert.ok(op.security.length > 0, `${op.operationId} authenticates but declares no security`)
      }
    }
  }
})

test('a route the service refuses without Idempotency-Key says so in the description', () => {
  const doc = JSON.parse(readFileSync(root('openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, { operationId: string; parameters?: { name: string }[] }>>
  }
  for (const ms of Object.values(doc.paths)) {
    for (const op of Object.values(ms)) {
      const spec = ROUTES[op.operationId as keyof typeof ROUTES]
      const declared = (op.parameters ?? []).some((p) => p.name === 'Idempotency-Key')
      assert.equal(
        declared,
        spec.idempotency === 'required',
        `${op.operationId}: the header is a 400 from the service, so the description must match`,
      )
    }
  }
})

test('every resource the table exposes is a real segment, not an empty one', () => {
  // The gateway routes on `resources`, so a route whose public path has no second segment would be
  // routed by the prefix `/v1/` — i.e. by everything. Cheap to check, and the day it happens the
  // symptom is a gateway rule that swallows the whole surface.
  for (const r of RESOURCES) {
    assert.match(r, /^[a-z][a-z0-9-]*$/, `"${r}" is not a routable resource segment`)
  }
})
