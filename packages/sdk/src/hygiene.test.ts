import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * THE TEST THIS REPOSITORY EXISTS FOR.
 *
 * `docs/ecosystem/03-repository-responsibilities.md` §1.4 makes `cloudsforge-sdk` the ONE public
 * repository in the programme. Everything else in the estate is private, and the boundary between
 * them is enforced here rather than by whoever reviews the next pull request. A leak across it
 * cannot be undone: a published package is in the registry, in the fork network and in somebody's
 * mirror the moment it lands.
 *
 * ## What counts as internal, stated precisely
 *
 * A rule nobody can apply is not a rule, so each pattern below names the thing it prevents:
 *
 *   - **Internal hostnames.** `http://<service>` on the `app` network, `*.internal`, and any
 *     database DSN. These describe the estate's topology, which is the first thing an attacker
 *     wants and the last thing a client library needs.
 *   - **Operator and admin routes.** `/admin/*`, `/internal/*`, moderation and dispute-resolution
 *     paths. The gateway refuses `/internal` outright at a priority nothing can outrank; naming
 *     one in a public client would advertise a door that is bolted.
 *   - **Credentials.** Any API-token or private-key shape.
 *   - **`stack/` paths.** The deployment repository is not a third party's concern.
 *   - **Private repository identifiers.** `cloudsforge-online/micro-*`, git remotes, and any
 *     dependency on a package a stranger cannot fetch.
 *
 * ## The one deliberate exception, and why
 *
 * A citation like `wallet/src/server.ts:440` DOES ship. It is a service-relative source path, not a
 * hostname, a credential, a repository URL or a route. It is also the most valuable thing in this
 * package: this estate has shipped clients built against a surface somebody imagined, and the
 * citations are how the next reader checks that these methods correspond to routes that exist.
 * Removing them would remove the evidence and leave the claim. The exception is narrow — a path
 * ending `/src/<file>.ts` with an optional line number — and everything else on the list is
 * refused.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

interface Rule {
  readonly name: string
  readonly pattern: RegExp
  readonly why: string
}

const RULES: readonly Rule[] = [
  {
    name: 'internal hostname',
    // `http://identity`, `http://wallet:8080` — a bare host with no dot is a container name on the
    // estate's private network and cannot resolve anywhere else.
    pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|api\.|auth\.|explorer\.|www\.)[a-z][a-z0-9-]*(:\d+)?(\/|$|["'`\s])/i,
    why: 'a container hostname on the app network describes the estate topology and resolves nowhere else',
  },
  {
    name: 'internal TLD',
    pattern: /\b[a-z0-9-]+\.(internal|local|svc|cluster\.local)\b/i,
    why: 'an internal DNS name is topology, not API surface',
  },
  {
    name: 'database DSN',
    pattern: /\b(postgres|postgresql|mysql|redis|mongodb):\/\//i,
    why: 'a client library has no database, and a DSN names one of ours',
  },
  {
    name: 'admin or internal route',
    pattern: /["'`](\/(?:admin|internal)\/[a-z]|\/v1\/(?:admin|internal|moderation)\/)/i,
    why: 'the gateway refuses /internal outright; naming an operator route advertises a bolted door',
  },
  {
    name: 'committed credential',
    pattern: /sk-proj-[A-Za-z0-9_-]{20,}|gh[pos]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/,
    why: 'a pushed credential is compromised the moment it lands',
  },
  {
    name: 'stack/ path',
    pattern: /\bstack\/(deploy|infra|scripts|repos|docs)\b/,
    why: 'the deployment repository is not a third party’s concern',
  },
  {
    name: 'private repository identifier',
    pattern: /cloudsforge-online\/|git@github\.com|github\.com[:/]cloudsforge/i,
    why: 'a public package must not name a repository a stranger cannot fetch',
  },
  {
    name: 'service-to-service token vocabulary',
    // The estate's internal auth. A third party gets a devplatform key, never one of these.
    pattern: /\bSERVICE_TOKEN_SECRET\b|\bservice token secret\b|\bJWKS_URL\b|\bINTERNAL_[A-Z_]+\b/,
    why: 'internal service credentials have no place in a public client',
  },
]

/** The narrow exception: a service-relative source citation, with or without a line number. */
const CITATION = /\b[a-z][a-z-]*\/src\/[a-z0-9.]+\.ts(:\d+)?\b/gi

/**
 * Files that become a published tarball, plus the README a stranger reads first.
 *
 * BOTH packages, not just this one. The scan lives here because this is where the rules are, but
 * `@cloudsforge/cli` is published from the same repository under the same promise, and a leak in
 * its help text would be just as permanent.
 */
function publishedSources(): readonly string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      // Tests are excluded from the tarball by tsconfig.build.json and are the one place a
      // hostname-shaped fixture is legitimate.
      if (entry.endsWith('.test.ts')) continue
      if (entry.endsWith('.ts')) files.push(full)
    }
  }
  for (const name of readdirSync(path.join(repoRoot, 'packages'))) {
    const root = path.join(repoRoot, 'packages', name)
    if (!statSync(root).isDirectory()) continue
    walk(path.join(root, 'src'))
    for (const doc of ['README.md', 'LICENSE']) {
      const full = path.join(root, doc)
      try {
        statSync(full)
        files.push(full)
      } catch {
        // Asserted separately below; a missing README is its own failure, not a scan failure.
      }
    }
  }
  return files
}

test('nothing internal appears in any file that is published', () => {
  const findings: string[] = []
  for (const file of publishedSources()) {
    const raw = readFileSync(file, 'utf8')
    // Blank out the deliberate exception before scanning, so a citation cannot trip another rule
    // and so the exception is visible in one place rather than smeared across seven patterns.
    const text = raw.replace(CITATION, '<citation>')
    for (const rule of RULES) {
      for (const [index, line] of text.split('\n').entries()) {
        const match = rule.pattern.exec(line)
        if (match) {
          findings.push(
            `${path.relative(repoRoot, file)}:${index + 1}  ${rule.name} — ${rule.why}\n    ${line.trim().slice(0, 160)}`,
          )
        }
      }
    }
  }
  assert.deepEqual(findings, [], `internal material in published files:\n${findings.join('\n')}`)
})

test('the published package declares no dependency a stranger cannot fetch', () => {
  // Rule 5: `pnpm pack` must produce a tarball a stranger could use. A `link:` or `workspace:`
  // dependency on a private repository is the one thing that makes that impossible, and it is what
  // every service in this estate does — so the check is not hypothetical.
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    files?: string[]
    publishConfig?: { access?: string }
  }
  const declared = { ...manifest.dependencies, ...manifest.peerDependencies }
  assert.deepEqual(
    declared,
    {},
    'the SDK has zero runtime dependencies, deliberately — see the README’s dependency decision',
  )
  assert.equal(manifest.publishConfig?.access, 'public')
  assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE'])
  assert.equal(
    manifest.files?.includes('src'),
    false,
    'shipping src would put the test fixtures and the workspace layout in the tarball',
  )
})

test('the workspace itself links nothing private', () => {
  // Belt and braces: a link: protocol anywhere in the workspace would make `pnpm install` fail for
  // anyone outside the org, whatever the package manifests say.
  for (const name of ['package.json', 'pnpm-workspace.yaml']) {
    const text = readFileSync(path.join(repoRoot, name), 'utf8')
    assert.equal(/link:|file:\.\./.test(text), false, `${name} references a path outside this repository`)
  }
})

test('a README exists and states the dependency decision', () => {
  // 17-definition-of-done §9: "a doc that describes intent rather than behaviour" is not done. The
  // dependency decision is the one thing about this package that cannot be read off the code, so
  // its absence from the README is a defect and not a style preference.
  const readme = readFileSync(path.join(packageRoot, 'README.md'), 'utf8')
  for (const heading of ['dependenc', 'stable', 'does not offer']) {
    assert.ok(
      readme.toLowerCase().includes(heading),
      `the package README must address "${heading}"`,
    )
  }
})
