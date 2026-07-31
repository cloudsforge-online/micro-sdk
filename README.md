# cloudsforge-sdk

The workspace that publishes **[`@cloudsforge/sdk`](packages/sdk)** — the typed client for the
CloudsForge public API — and **[`@cloudsforge/cli`](packages/cli)**, the `cloudsforge` command.

```
pnpm install && pnpm check
```

Specification: `docs/ecosystem/03-repository-responsibilities.md` §1.4.

---

## This is the one repository in the programme that is meant to be public

Everything else is private. That single fact is the reason this repository exists separately from
the shared contract packages, and it drives every decision in it:

- **It contains nothing internal.** No internal hostnames, no service-to-service credentials, no
  admin or operator routes, no deployment paths, and no dependency on a repository a stranger
  cannot fetch. `packages/sdk/src/hygiene.test.ts` fails the build if any appear, with a named rule
  per pattern and one deliberate, documented exception.
- **Its dependency surface is a promise.** `@cloudsforge/sdk` has **zero** runtime dependencies. It
  cannot consume the private contract packages the way services do, so the values it needs are
  duplicated and checked — the argument is in full in
  [the package README](packages/sdk/README.md#the-dependency-decision-and-why), and the check is
  `pnpm drift`.
- **Backwards compatibility is the product.** Removing or narrowing a public export is a breaking
  change. CI proves the repo did not make one, two ways: the estate's contract-compatibility
  checker diffs the exported *type* surface against the base ref, and `index.test.ts` pins the
  exported *value* surface as a list that has to be edited on purpose.
- **It never invents a route.** Every request lives in one table with the exact `path:line` in the
  owning service where the route is registered, and a test walks the client to prove no method
  calls anything outside it. This estate has shipped clients built against imagined surfaces
  before — including one that returned 403 on every marketplace listing.

---

## Layout

```
packages/sdk/   @cloudsforge/sdk   the client, the route table, money, idempotency, transport
packages/cli/   @cloudsforge/cli   the `cloudsforge` binary — read-only, --json, real exit codes
tools/drift.ts  the check that the duplicated chain constants still match their source
```

## Scripts

| | |
| --- | --- |
| `pnpm typecheck` | Strict TypeScript across both packages |
| `pnpm test` | `node:test` only. Hermetic — no network, no sibling checkout, nothing skipped |
| `pnpm build` | Emits `dist/` for both packages |
| `pnpm drift` | Compares the duplicated chain constants against the private contract source. Needs a sibling checkout; CI supplies one |
| `pnpm check` | `typecheck` + `test` |

`pnpm test` is deliberately hermetic: it has to pass for somebody who has only the published
tarball. `pnpm drift` is the half that cannot be, so it is a separate script and a separate CI job
rather than a test that would otherwise have to skip.

---

## Publishing

**This repository is created private. It is ready to be made public; making it so is the owner's
decision, not an implementation detail.**

Before it is flipped, all of these should be true:

1. `pnpm drift` is green against the current contract source — the published constants agree with
   the ones the platform credits money at.
2. The gateway's path mapping for `api.cloudsforge.online/v1` exists. Today it does not, and the
   SDK says so in its README and offers `pathPrefix` as the seam. A public SDK whose base URL is a
   guess is a support burden from day one.
3. `api.cloudsforge.online` no longer points at the game API. It currently does; the rename to
   `worlds-api.` is a prerequisite recorded in the migration backlog, and renaming a hostname after
   third parties are on it costs a twelve-month deprecation cycle.
4. The developer platform can issue a credential. Until it can, the only usable credential is one
   an operator hands over by other means, and `clientCredentials` has no default token endpoint.
5. Every CI job is green on `main`, including secret hygiene.

Publishing to npm is a separate decision again, and neither package is published yet. `pnpm pack`
produces a usable tarball today: `@cloudsforge/sdk` has no dependencies at all, and
`@cloudsforge/cli` depends only on it, with the workspace protocol resolved at pack time.

---

## Licence

MIT.
