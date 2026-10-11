declare const FaceclawKitConnectionCounters: any

export function drainConnectionCounters(): Record<string, number> {
  const counts: Record<string, number> = {}
  const parsed = JSON.parse(String(FaceclawKitConnectionCounters.shared.drain())) as Record<string, unknown>
  for (const [name, count] of Object.entries(parsed)) {
    if (typeof count === 'number' && count > 0) counts[name] = count
  }
  return counts
}
