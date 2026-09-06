import { classifyAdvertisement, hasEvenManufacturerSignature, type EvenAdvertisement } from './even-advertisement'
import { hexToBytes } from '../util/hex-util'

export type IosAdvertisement = { identifier: string; name: string; manufacturerData: string; rssi: number; connectable: boolean }
export type IosDevice = EvenAdvertisement & { identifier: string }

/** Only a full vendor-advertised MAC may bind a manually entered address. */
export function identifyIosPeripheral(raw: IosAdvertisement): IosDevice | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw.identifier)) return null
  if (!hasEvenManufacturerSignature(hexToBytes(raw.manufacturerData))) return null
  const candidate = classifyAdvertisement({ ...raw, address: '', source: 'scan', bonded: false,
    txPower: null, seenAtMs: Date.now() })
  if (!candidate?.embeddedMac) return null
  return { ...candidate, address: candidate.embeddedMac, embeddedMacMismatch: false, identifier: raw.identifier.toUpperCase() }
}

export function deviceAddressError(addresses: { left: string; right: string; ring: string }): string | null {
  for (const role of ['right', 'left', 'ring'] as const) {
    const address = addresses[role]
    if (role === 'ring' && !address) continue
    if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(address)) return `${role === 'ring' ? 'Ring' : role === 'left' ? 'Left arm' : 'Right arm'} MAC address is invalid.`
  }
  const values = Object.values(addresses).filter(Boolean)
  return new Set(values).size === values.length ? null : 'Each device must have a different MAC address.'
}
