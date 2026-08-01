/**
 * Emit the public API's two derived artefacts from the one verified route table.
 *
 * ## Why both come from here
 *
 * `packages/sdk/src/routes.ts` is the only place in the estate that knows the public surface, and
 * every entry in it carries a `verifiedAt` citation into the line of the service that registers
 * the route. It was written by reading the services one route at a time, because this estate had
 * already shipped a run of clients built against a surface somebody imagined — recorded in
 * `docs/ecosystem/18-build-status.md` §3.3i and §3.3m. Cite the SECTION, never a count: that
 * ledger stopped carrying a running total precisely because four files in this repository said
 * "five" while it said "seven", and nothing could tell.
 *
 * Two things were missing that both describe that same surface:
 *
 *   1. **No OpenAPI description existed anywhere**, though
 *      `docs/ecosystem/11-data-and-contract-strategy.md`:288 names it as the mechanism this SDK is
 *      generated *from*. The named mechanism had no artefact.
 *   2. **The gateway had no public route map.** `deploy/gateway/dynamic/policy.yml` carried every
 *      rule about how a request is treated and nothing about where a public request goes.
 *
 * Hand-writing either would create a second truth that drifts from the first — which is the exact
 * failure mode 11 warns about, and which this estate has already met in `micro-brand` (a manifest
 * describing files that were rewritten after it was written) and `micro-ui` (a "Reproduce:" line
 * naming a validator that never existed). So both are generated, and `--check` fails if either
 * has drifted from the table.
 *
 * The direction is deliberate: OpenAPI is generated FROM the verified table rather than the table
 * from OpenAPI. 11 §288 assumed the reverse, but there is no description to generate from, and a
 * citation into a serving line is stronger evidence than a document nobody has checked.
 *
 * ## Why the two checks are separate flags
 *
 * `openapi.json` lives in this repository; the gateway map lives in `micro-deploy`, which is
 * private and which a stranger holding the published tarball does not have. That is the same split
 * `tools/drift.ts` already reasons about in its header: `pnpm test` has to pass with no sibling
 * checkout, so an invariant that needs one belongs in a CI job rather than in the suite.
 *
 * The gateway half was NOT split, and the consequence was run 30691403652 — `pnpm test` shelled out
 * to `--check`, `--check` read `../deploy/gateway/dynamic/public-api.yml` unconditionally, and
 * micro-sdk's workflow checks out only micro-sdk. So it is split now, and the split is drawn so
 * that neither half can be mistaken for the other:
 *
 *   * `--check` never claims the gateway was checked. It cannot print `every resource routed`.
 *   * `--gateway` never TOLERATES a missing map. There is no skip path: a map that is not there is
 *     exit 1, on a runner and on a laptop alike. A check that goes quiet when its input vanishes
 *     is worse than no check, because it still looks like evidence.
 *
 * Usage:
 *   node --import tsx tools/public-api.ts                  # write openapi.json
 *   node --import tsx tools/public-api.ts --check          # exit 1 if openapi.json is stale
 *   node --import tsx tools/public-api.ts --gateway        # exit 1 unless the map routes everything
 *   node --import tsx tools/public-api.ts --gateway <dir>  # …with the micro-deploy checkout named
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES, type RouteSpec } from '../packages/sdk/src/routes.ts'

const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))

const OPENAPI_OUT = here('openapi.json')

/** The map's path inside a micro-deploy checkout, wherever that checkout happens to be. */
const GATEWAY_REL = path.join('gateway', 'dynamic', 'public-api.yml')

const REPO_ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

/** Where a micro-deploy checkout usually is, in the order CI and a developer's machine put it. */
const DEPLOY_CANDIDATES = [
  process.env['CLOUDSFORGE_DEPLOY_DIR'],
  path.resolve(REPO_ROOT, '..', 'deploy'),
  path.resolve(REPO_ROOT, '.deploy'),
]

/**
 * The committed gateway map, or an error. Never a soft "not found" — see the header.
 *
 * An explicitly named root is STRICT: it is not allowed to fall back to a sibling. CI passes the
 * directory it just checked out, and a fallback would mean a failed checkout silently graded
 * against whatever else happened to be on disk.
 */
export function locateGateway(explicit?: string | undefined): string {
  if (explicit !== undefined) {
    const file = path.join(explicit, GATEWAY_REL)
    if (existsSync(file)) return file
    throw new Error(
      `--gateway ${explicit} contains no ${GATEWAY_REL}.\n` +
        'The named checkout is the one that must be graded, so this is a failure and not a\n' +
        'fallback: a check that quietly grades a different file is not a check.',
    )
  }
  const roots = DEPLOY_CANDIDATES.filter((value): value is string => Boolean(value))
  for (const root of roots) {
    const file = path.join(root, GATEWAY_REL)
    if (existsSync(file)) return file
  }
  throw new Error(
    'could not find the gateway route map. Pass --gateway <micro-deploy checkout>, set\n' +
      'CLOUDSFORGE_DEPLOY_DIR, or place a checkout next to this repository. Looked in:\n' +
      `${roots.map((r) => `  ${path.join(r, GATEWAY_REL)}`).join('\n')}\n\n` +
      'This is deliberately fatal. micro-sdk run 30691403652 failed because the map was absent on\n' +
      'the runner; the fix is to check micro-deploy out, never to let the check pass without it.',
  )
}

type Entry = RouteSpec & { key: string }
const entries: Entry[] = Object.entries(ROUTES).map(([key, r]) => ({ key, ...(r as RouteSpec) }))

/* ------------------------------------------------------------------ the layout */

/**
 * Services that serve `/v1/…` themselves. The rest are mounted under `/v1` by the gateway and
 * never see the prefix — see the header of the generated gateway file for why the split stops
 * there rather than being pushed into four shipped services.
 */
const NATIVE_V1 = new Set(
  entries.filter((e) => e.path.startsWith('/v1/')).map((e) => e.service),
)

/** The public path for a route: always versioned, regardless of what the service serves. */
export function publicPath(e: Entry): string {
  return e.path.startsWith('/v1/') ? e.path : `/v1${e.path}`
}

/** Top-level resource segment, which is what a gateway routes on. */
function resourceOf(e: Entry): string {
  const segs = publicPath(e).split('/').filter(Boolean)
  return segs[1] ?? ''
}

/**
 * A method+path claimed by two services would make a resource-oriented public layout ambiguous,
 * and the layout is only safe because there are none. Checked here rather than assumed, because
 * the day someone adds one is the day the gateway starts routing by coin flip.
 */
export function collisions(): string[] {
  const seen = new Map<string, string>()
  const out: string[] = []
  for (const e of entries) {
    const k = `${e.method} ${publicPath(e)}`
    const prev = seen.get(k)
    if (prev !== undefined && prev !== e.service) out.push(`${k}: ${prev} and ${e.service}`)
    else seen.set(k, e.service)
  }
  return out
}

/* ---------------------------------------------------------------------- OpenAPI */

/** `:id` in a service route is `{id}` in OpenAPI, and each becomes a declared parameter. */
function toOpenApiPath(p: string): { path: string; params: string[] } {
  const params: string[] = []
  const path = p.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    params.push(name)
    return `{${name}}`
  })
  return { path, params }
}

function buildOpenApi(): unknown {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of entries) {
    const { path, params } = toOpenApiPath(publicPath(e))
    const item = (paths[path] ??= {})
    const security =
      e.auth === 'none'
        ? []
        : e.auth === 'user'
          ? [{ bearerAuth: [] }]
          : [{ bearerAuth: [] }, { apiKey: [] }]

    const parameters: unknown[] = params.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))
    if (e.idempotency === 'required') {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description:
          'The service REFUSES this request without the header — a 400, not a convention. Reuse the same key to retry safely; a replay returns the original result rather than acting twice.',
        schema: { type: 'string' },
      })
    }

    item[e.method.toLowerCase()] = {
      operationId: e.key,
      summary: `${e.method} ${publicPath(e)}`,
      description: `Owned by \`${e.service}\`. Verified against \`${e.verifiedAt}\`.`,
      tags: [e.service],
      ...(parameters.length ? { parameters } : {}),
      security,
      responses: {
        '200': { description: 'Success.' },
        '400': { description: 'The request was refused. The body carries `error.code` and `error.requestId`.' },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'CloudsForge public API',
      version: '0.1.0',
      description:
        'Generated from the verified route table in @cloudsforge/sdk. Every operation cites the ' +
        'line of the owning service that registers it. Paths are as the GATEWAY serves them: ' +
        'uniformly versioned under /v1, which four of the eight services do not do themselves.',
      license: { name: 'MIT' },
    },
    servers: [{ url: 'https://api.cloudsforge.online', description: 'Production' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'A developer platform API key, presented as a bearer token.',
        },
      },
    },
    tags: [...new Set(entries.map((e) => e.service))].sort().map((name) => ({ name })),
    paths,
  }
}

/* ---------------------------------------------------------------------- gateway */

/** The resources each service owns, which is all a gateway needs to route. */
export function resourcesByService(): Map<string, string[]> {
  const out = new Map<string, Set<string>>()
  for (const e of entries) {
    const set = out.get(e.service) ?? new Set<string>()
    set.add(resourceOf(e))
    out.set(e.service, set)
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]))
}

/**
 * Every resource in the table must be reachable through some router in the committed gateway file,
 * and every router must correspond to a service that owns resources. Both directions: an
 * unrouted resource is a public 404, and a router for nothing is a rule that will outlive its
 * reason.
 */
export function gatewayGaps(yaml: string): string[] {
  // COMMENTS ARE STRIPPED FIRST, and the omission was a live bug in this function: the generated
  // file's own header explains the layout using `api/v1/rates` as the example, so removing the
  // router for /v1/rates left the checker matching the PROSE and reporting everything routed.
  //
  // That is the sixth time this estate has met the same shape — a CI guard firing on the comment
  // explaining it, a rule rejecting every service it protected, a hostname guard tripping on the
  // file documenting the rule, an nginx guard matching its own warning, a settlement-key rule
  // matching the defect it cites — and the first time it made a check too PERMISSIVE rather than
  // too strict. Both directions are the same mistake: a checker that reads text cannot tell a
  // rule from a sentence about one.
  const effective = yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  const gaps: string[] = []
  for (const [service, resources] of resourcesByService()) {
    for (const r of resources) {
      if (!effective.includes(`PathPrefix(\`/v1/${r}\`)`)) {
        gaps.push(`${service}: /v1/${r} is not routed`)
      }
    }
  }
  return gaps
}

/* ------------------------------------------------------------------------- main */

/** `--gateway` may be bare or carry a root; a following flag is another option, not a directory. */
function gatewayRoot(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--gateway')
  if (at === -1) return undefined
  const next = argv[at + 1]
  return next !== undefined && !next.startsWith('--') ? next : undefined
}

/** Exit 1 unless the committed map routes every resource in the table. Absence is exit 1 too. */
function checkGateway(root: string | undefined): number {
  const file = locateGateway(root)
  const gaps = gatewayGaps(readFileSync(file, 'utf8'))
  if (gaps.length) {
    console.error(`the gateway does not route every public resource — ${file}:`)
    for (const g of gaps) console.error(`  ${g}`)
    return 1
  }
  console.log(`ok: every resource routed by ${file}`)
  return 0
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const gateway = argv.includes('--gateway')

  const clash = collisions()
  if (clash.length) {
    console.error('method+path collisions across services — a resource-oriented public layout is unsafe:')
    for (const c of clash) console.error(`  ${c}`)
    return 1
  }

  const openapi = `${JSON.stringify(buildOpenApi(), null, 2)}\n`
  let bad = false

  if (check) {
    const current = (() => {
      try {
        return readFileSync(OPENAPI_OUT, 'utf8')
      } catch {
        return ''
      }
    })()
    if (current !== openapi) {
      console.error(`stale: ${OPENAPI_OUT} — run without --check`)
      bad = true
    } else {
      // Deliberately silent about the gateway. `--check` did not read it, so it must not be
      // possible to read this line as evidence that it did.
      console.log(`ok: ${entries.length} routes, openapi in sync`)
    }
  }

  if (gateway && checkGateway(gatewayRoot(argv)) !== 0) bad = true

  if (check || gateway) return bad ? 1 : 0

  writeFileSync(OPENAPI_OUT, openapi)
  console.log(`wrote ${OPENAPI_OUT} — ${entries.length} routes`)
  // Writing is not a gate, so a developer with no micro-deploy checkout is not stopped here — but
  // they are told, in the same breath, that the map was not graded. `--gateway` is the gate.
  const found = DEPLOY_CANDIDATES.filter((value): value is string => Boolean(value)).find((root) =>
    existsSync(path.join(root, GATEWAY_REL)),
  )
  if (found === undefined) {
    console.log('note: no micro-deploy checkout found, so the gateway map was NOT checked')
    return 0
  }
  return checkGateway(found)
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (err) {
  // A stack trace for a missing checkout reads like a crash in the tool. It is a verdict.
  console.error(`public-api: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
