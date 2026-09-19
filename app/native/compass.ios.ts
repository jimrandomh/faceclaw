import { type CompassEvent } from './compass-types'
export * from './compass-types'

type CompassSession = { setCompassEnabled(enabled: boolean): void }
const owners = new Set<string>()
const listeners = new Set<(event: CompassEvent) => void>()
let session: CompassSession | null = null

/** Holds and listeners survive disconnect/reconnect and opening before Connect. */
export function bindCompassSession(next: CompassSession): void {
  if (session && session !== next) session.setCompassEnabled(false)
  session = next
  session.setCompassEnabled(owners.size > 0)
}

export function setCompassEnabled(enabled: boolean, owner = 'compass'): void {
  if (enabled) owners.add(owner)
  else owners.delete(owner)
  session?.setCompassEnabled(owners.size > 0)
}

export function addCompassListener(listener: (event: CompassEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function receiveCompassEvent(event: CompassEvent): void {
  for (const listener of [...listeners]) listener(event)
}
