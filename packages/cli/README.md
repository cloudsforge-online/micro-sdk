# @cloudsforge/cli

The CloudsForge public API, from a shell. Built on [`@cloudsforge/sdk`](../sdk).

```bash
pnpm add -g @cloudsforge/cli
export CLOUDSFORGE_BASE_URL=https://api.cloudsforge.online
export CLOUDSFORGE_API_KEY=…

cloudsforge listings
cloudsforge portfolio --json | jq '.balances[] | {asset: .assetCode, amount}'
cloudsforge routes
```

The binary is `cloudsforge`, not `cfctl`. The estate has an internal `cfctl` for operators; giving
them the same name would put somebody one `$PATH` entry away from running the wrong one.

---

## Every command is read-only, on purpose

The SDK can spend, transfer, convert and withdraw. **This CLI cannot.**

A shell is where a typo, a stale history entry or a mis-expanded variable becomes a request, and
those four are exactly the requests that must not be made by accident. "Enough to be useful and no
more" is: authenticate, list, inspect — and `--json`, so anything else is done through the SDK in a
file somebody reviewed.

---

## Commands

| Command | |
| --- | --- |
| `auth status` | Resolve the credential and say who it belongs to |
| `routes` | Every route the SDK can call, and the `path:line` each was verified against. Needs no network |
| `rates [--asset CODE]` | The rate board, or one asset. **Public** |
| `listings [--status S]` · `listing <id>` | Marketplace. **Public** |
| `markets [--status S]` · `market <id>` | Prediction markets. **Public** |
| `titles` | Registered game titles. **Public** |
| `catalogue` | What the token mint will deploy. **Public** |
| `portfolio` | Balances and observed wallets |
| `wallets` · `deposits` · `credits` · `withdrawals` | Your wallet |
| `orders [--role buyer\|seller]` · `tokens` | Your marketplace and mint activity |
| `activity [--category C]` | Your activity feed |

A **public** command needs no credential and is not sent one.

---

## Exit codes

So a pipeline can branch without parsing English.

| | | Retry? |
| --- | --- | --- |
| `0` | ok | |
| `2` | usage — the command line was wrong; no request was made | no |
| `3` | auth — 401 or 403 | not until the credential changes |
| `4` | not found — 404 | no |
| `5` | refused — another 4xx; the peer decided | no |
| `6` | unavailable — 5xx or a transport fault | yes, with backoff |
| `7` | timeout — the deadline expired; the operation may or may not have happened | with care |
| `1` | anything else | |

126, 127 and 128+n are left to the shell.

---

## Credentials

Resolved in this order, flags beating the environment:

1. `--token-url` + `--client-id` + `--client-secret` (or `CLOUDSFORGE_TOKEN_URL`,
   `CLOUDSFORGE_CLIENT_ID`, `CLOUDSFORGE_CLIENT_SECRET`) — OAuth client credentials
2. `--token` / `CLOUDSFORGE_TOKEN` — a bearer token you hold
3. `--api-key` / `CLOUDSFORGE_API_KEY`
4. anonymous — which is not an error, because half the commands are public reads

**Prefer the environment variables.** A secret on a command line is in your shell history and in
`ps`.

There is no default `--base-url`. A wrong default would send your credential to a host you did not
choose.

---

## `--json`

Prints the decoded object. Every amount is a **decimal string**, never a JSON number: `jq` on a
number is where an 18-decimal amount stops being the amount.

The table and the JSON render the same decoded object, so switching to `--json` after eyeballing
the table shows the same fields under the same names.

---

## Output that refuses to lie

Three places where the platform distinguishes two things a careless client would render
identically, and this CLI keeps them apart:

- `portfolio` always prints `degraded`, even when it is empty. "We could not reach the indexer" and
  "there is nothing on chain" are different answers.
- `rates` lists unusable assets **with the reason**. Omitting them is how a deposit page loses a
  coin.
- `market` never prints a pool without its `as of` and `stale`. It is a mirror of on-chain state,
  and a pool shown without a timestamp reads as live.

---

## Licence

MIT.
