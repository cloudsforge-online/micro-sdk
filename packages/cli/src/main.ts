#!/usr/bin/env node
/**
 * The binary. Everything it does lives in `run.ts`, which takes its I/O as an argument so the whole
 * CLI is testable without spawning a process or capturing a stream.
 *
 * This file owns exactly two things `run` must not: the process exit code, and the last-resort
 * handler for a fault that escapes it. Setting `process.exitCode` rather than calling
 * `process.exit()` lets stdout drain — `process.exit()` on a piped stdout truncates the last write,
 * which is how a `--json` output ends up unparseable only when it is long.
 */

import { run } from './run.ts'

const code = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
}).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  return 1 as const
})

process.exitCode = code
