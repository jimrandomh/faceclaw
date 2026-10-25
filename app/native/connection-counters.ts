declare const com: any;

/**
 * Connection-reliability event counts since the last call, from the shared
 * Kotlin session core (ConnectionCounters.kt), which keeps them process-wide.
 */
export function drainConnectionCounters(): Record<string, number> {
  const counts: Record<string, number> = {};
  const parsed = JSON.parse(String(com.faceclaw.app.ConnectionCounters.drain())) as Record<string, unknown>;
  for (const [name, count] of Object.entries(parsed)) {
    if (typeof count === "number" && count > 0) counts[name] = count;
  }
  return counts;
}
