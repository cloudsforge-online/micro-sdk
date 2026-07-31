/**
 * Argument parsing, by hand and on purpose.
 *
 * `node:util`'s `parseArgs` would do most of this, but it throws on an unknown option with a
 * message that names the option and nothing else, and a public CLI's first impression is what it
 * says when you get it wrong. This produces "unknown option --jsn; did you mean --json?" instead.
 *
 * No dependency, either, which matters more here than usual: a CLI a stranger installs is a
 * dependency tree a stranger audits.
 */

import { EXIT } from './exit.ts'

export class UsageProblem extends Error {
  readonly exitCode = EXIT.USAGE
  constructor(message: string) {
    super(message)
    this.name = 'UsageProblem'
  }
}

export interface Parsed {
  /** Positional words: `wallets list` → `['wallets', 'list']`. */
  readonly words: readonly string[]
  readonly flags: Readonly<Record<string, string | boolean>>
}

/** Options that take a value. Everything else is a boolean flag. */
const VALUED = new Set([
  'base-url',
  'api-key',
  'token',
  'token-url',
  'client-id',
  'client-secret',
  'scope',
  'limit',
  'cursor',
  'status',
  'asset',
  'category',
  'product',
  'role',
  'title',
  'deadline',
  'path-prefix',
])

const BOOLEAN = new Set(['json', 'help', 'version', 'include-retired'])

export function parse(argv: readonly string[]): Parsed {
  const words: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--') {
      words.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith('-')) {
      words.push(arg)
      continue
    }

    const [rawName, inlineValue] = splitOnce(arg.replace(/^--?/, ''), '=')
    const name = rawName === 'h' ? 'help' : rawName === 'v' ? 'version' : rawName

    if (VALUED.has(name)) {
      const value = inlineValue ?? argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new UsageProblem(`--${name} needs a value`)
      }
      if (inlineValue === undefined) index += 1
      flags[name] = value
      continue
    }
    if (BOOLEAN.has(name)) {
      if (inlineValue !== undefined) throw new UsageProblem(`--${name} takes no value`)
      flags[name] = true
      continue
    }
    throw new UsageProblem(unknownOption(name))
  }

  return { words, flags }
}

/** "did you mean" beats "unknown option", and costs one Levenshtein. */
function unknownOption(name: string): string {
  const known = [...VALUED, ...BOOLEAN]
  const closest = known
    .map((candidate) => ({ candidate, distance: distance(name, candidate) }))
    .sort((a, b) => a.distance - b.distance)[0]
  const suggestion = closest && closest.distance <= 3 ? `; did you mean --${closest.candidate}?` : ''
  return `unknown option --${name}${suggestion}`
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator)
  if (at === -1) return [text, undefined]
  return [text.slice(0, at), text.slice(at + 1)]
}

function distance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const grid: number[] = new Array<number>(rows * cols).fill(0)
  for (let i = 0; i < rows; i += 1) grid[i * cols] = i
  for (let j = 0; j < cols; j += 1) grid[j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      grid[i * cols + j] = Math.min(
        (grid[(i - 1) * cols + j] ?? 0) + 1,
        (grid[i * cols + (j - 1)] ?? 0) + 1,
        (grid[(i - 1) * cols + (j - 1)] ?? 0) + cost,
      )
    }
  }
  return grid[rows * cols - 1] ?? Math.max(a.length, b.length)
}

export function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name]
  return typeof value === 'string' ? value : undefined
}

export function boolFlag(parsed: Parsed, name: string): boolean {
  return parsed.flags[name] === true
}

export function numberFlag(parsed: Parsed, name: string): number | undefined {
  const value = stringFlag(parsed, name)
  if (value === undefined) return undefined
  const parsedValue = Number(value)
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new UsageProblem(`--${name} must be a positive integer (got ${value})`)
  }
  return parsedValue
}
