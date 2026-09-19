/**
 * One-line error text safe for a status label: control characters stripped,
 * whitespace collapsed, optionally truncated. Shared by the view models so a
 * fix to error rendering lands everywhere at once.
 */
export function formatErrorMessage(error: unknown, maxLength?: number): string {
  const raw = (error as Error)?.message ?? String(error);
  const sanitized = raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  if (maxLength != null && sanitized.length > maxLength) {
    return `${sanitized.slice(0, Math.max(0, maxLength - 3))}...`;
  }
  return sanitized;
}
