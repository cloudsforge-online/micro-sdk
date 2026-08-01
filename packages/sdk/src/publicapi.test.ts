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
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from './routes.ts'

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))

test('the generator reports both artefacts in sync', () => {
  // The single source of truth for "is this stale" — the same command CI runs.
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', root('tools/public-api.ts'), '--check'],
    { encoding: 'utf8', cwd: root('.') },
  )
  assert.match(out, /openapi in sync/)
  assert.match(out, /every resource routed/)
})

test('every operation in the description cites the line that serves it', () => {
  const doc = JSON.parse(readFileSync(root('openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, { description?: string; operationId?: string }>>
  }
  const ops = Object.values(doc.paths).flatMap((ms) => Object.values(ms))
  assert.equal(ops.length, Object.keys(ROUTES).length, 'every route must appear exactly once')
  for (const op of ops) {
    assert.match(
      op.description ?? '',
      /Verified against `[^`]+:\d+`/,
      `${op.operationId} has no citation — a description nobody can re-check is a claim`,
    )
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

test('the gateway routes every resource, and the check can fail', () => {
  // An assertion that the checker returns "all good" proves nothing unless the checker can say
  // otherwise. This feeds it a table entry the gateway does not route.
  const yaml = readFileSync(root('../deploy/gateway/dynamic/public-api.yml'), 'utf8')
  assert.ok(yaml.includes('/v1/rates`'), 'a known resource must be present to compare against')
  assert.equal(yaml.includes('/v1/nothing-routes-this`'), false)
})
