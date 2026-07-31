/**
 * Output. Two modes, one source of truth.
 *
 * `--json` prints exactly what came back, machine-readable. The default prints a table a person
 * can read. Both render the SAME decoded object, so a script that switches to `--json` after
 * eyeballing the table sees the same fields under the same names — the alternative is a CLI whose
 * two modes drift and whose table shows a field the JSON does not have.
 *
 * ## The bigint problem, and why it is not a problem here
 *
 * `JSON.stringify` throws on a bigint: "Do not know how to serialize a BigInt". The SDK decodes
 * every money field into one, so the naive `JSON.stringify(result)` fails on almost every command.
 * The replacer below turns a bigint into its DECIMAL STRING — the exact form it arrived in, and the
 * exact form `jq` can hand back to another tool without an IEEE 754 double in the middle.
 *
 * It must never become `Number(value)`. `jq '.balances[0].amount'` on a number is where an
 * 18-decimal amount stops being the amount.
 */

/** `JSON.stringify` replacer: bigint → decimal string, everything else untouched. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2)
}

export interface Column<T> {
  readonly heading: string
  readonly of: (row: T) => string
  /** Right-align, for anything that is a quantity. Numbers line up or they cannot be compared. */
  readonly numeric?: boolean
}

/**
 * A plain-text table, padded to the widest cell.
 *
 * No box drawing and no colour: this output is piped as often as it is read, and an escape
 * sequence in a pipe is noise somebody has to strip.
 */
export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (rows.length === 0) return '(none)'
  const cells = rows.map((row) => columns.map((column) => column.of(row)))
  const widths = columns.map((column, index) =>
    Math.max(column.heading.length, ...cells.map((row) => (row[index] ?? '').length)),
  )
  const line = (values: readonly string[]): string =>
    values
      .map((value, index) =>
        columns[index]?.numeric === true
          ? value.padStart(widths[index] ?? 0)
          : value.padEnd(widths[index] ?? 0),
      )
      .join('  ')
      .trimEnd()

  return [
    line(columns.map((column) => column.heading.toUpperCase())),
    line(widths.map((width) => '-'.repeat(width))),
    ...cells.map(line),
  ].join('\n')
}

/** `key: value` pairs for a single object. */
export function details(pairs: readonly (readonly [string, string])[]): string {
  const width = Math.max(...pairs.map(([key]) => key.length))
  return pairs.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n')
}

/** A timestamp, or a dash. An empty cell and a missing value must not look the same. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '-' : value
}
