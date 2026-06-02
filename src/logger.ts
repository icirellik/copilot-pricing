let debugEnabled = false;

/** Enable/disable debug logging (wired to the --debug flag). */
export function setDebug(value: boolean): void {
  debugEnabled = value;
}

/** Write a diagnostic line to stderr, but only when --debug is set. */
export function log(message: string): void {
  if (debugEnabled) {
    process.stderr.write(`[copilot-price] ${message}\n`);
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
