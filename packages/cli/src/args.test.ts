import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageProblem, boolFlag, numberFlag, parse, stringFlag } from './args.ts'

test('positional words and flags are separated', () => {
  const parsed = parse(['wallets', '--limit', '10', '--json'])
  assert.deepEqual([...parsed.words], ['wallets'])
  assert.equal(stringFlag(parsed, 'limit'), '10')
  assert.equal(boolFlag(parsed, 'json'), true)
})

test('--name=value and --name value are the same thing', () => {
  assert.equal(stringFlag(parse(['x', '--limit=10']), 'limit'), '10')
  assert.equal(stringFlag(parse(['x', '--limit', '10']), 'limit'), '10')
})

test('-h and -v are the short forms, and nothing else is', () => {
  assert.equal(boolFlag(parse(['-h']), 'help'), true)
  assert.equal(boolFlag(parse(['-v']), 'version'), true)
  assert.throws(() => parse(['-x']), UsageProblem)
})

test('a valued option with no value is a usage problem, not an empty string', () => {
  // `--limit --json` silently becoming limit="" is how a script sends a request nobody meant.
  assert.throws(() => parse(['x', '--limit']), UsageProblem)
  assert.throws(() => parse(['x', '--limit', '--json']), UsageProblem)
})

test('a boolean flag rejects a value rather than ignoring it', () => {
  assert.throws(() => parse(['x', '--json=false']), UsageProblem)
})

test('an unknown option suggests the nearest known one', () => {
  const err = parse.bind(null, ['x', '--jsn'])
  assert.throws(err, (e: unknown) => e instanceof UsageProblem && /did you mean --json\?/.test(e.message))
})

test('an unknown option with no near match says so without a wild guess', () => {
  assert.throws(
    () => parse(['x', '--completely-unrelated-thing']),
    (e: unknown) => e instanceof UsageProblem && !/did you mean/.test(e.message),
  )
})

test('-- ends option parsing, so a value that looks like a flag survives', () => {
  const parsed = parse(['listing', '--', '--not-a-flag'])
  assert.deepEqual([...parsed.words], ['listing', '--not-a-flag'])
})

test('numberFlag refuses anything that is not a positive integer', () => {
  assert.equal(numberFlag(parse(['x', '--limit', '25']), 'limit'), 25)
  assert.equal(numberFlag(parse(['x']), 'limit'), undefined)
  assert.throws(() => numberFlag(parse(['x', '--limit', '0']), 'limit'), UsageProblem)
  assert.throws(() => numberFlag(parse(['x', '--limit', '-1']), 'limit'), UsageProblem)
  assert.throws(() => numberFlag(parse(['x', '--limit', '2.5']), 'limit'), UsageProblem)
  assert.throws(() => numberFlag(parse(['x', '--limit', 'lots']), 'limit'), UsageProblem)
})

test('a subcommand is a word, not a flag', () => {
  assert.deepEqual([...parse(['auth', 'status']).words], ['auth', 'status'])
})
