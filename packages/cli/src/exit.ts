/**
 * Exit codes, and what each one tells the shell that wrote the pipeline.
 *
 * A CLI that exits 1 for everything forces the caller to parse stderr to decide whether to retry —
 * which means parsing English, which means the retry breaks when the message is reworded. These
 * codes exist so a script can branch without reading a word.
 *
 * The three that matter in a loop:
 *
 *   - `USAGE` (2) and `NOT_FOUND` (4) will never succeed on a retry. Stop.
 *   - `AUTH` (3) will not succeed until the credential changes. Stop, and say which variable.
 *   - `UNAVAILABLE` (6) and `TIMEOUT` (7) may succeed later. Retry, with a backoff.
 *
 * Chosen to avoid the reserved range: 126, 127 and 128+n belong to the shell, and 1 is kept as the
 * catch-all so an unforeseen fault is never mistaken for one of the specific answers below.
 */
export const EXIT = {
  OK: 0,
  /** An unexpected fault. Deliberately vague, because pretending to know would be worse. */
  FAILURE: 1,
  /** The command line was wrong. No request was made. */
  USAGE: 2,
  /** 401 or 403 — the credential is missing, wrong, or not permitted here. */
  AUTH: 3,
  /** 404 — and "is not yours" answers 404 too, on purpose. */
  NOT_FOUND: 4,
  /** Any other 4xx. The peer decided; the request as written will not succeed. */
  REFUSED: 5,
  /** 5xx, a transport fault, or a circuit that never closed. Worth retrying. */
  UNAVAILABLE: 6,
  /** The deadline expired. The operation may or may not have been performed. */
  TIMEOUT: 7,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
