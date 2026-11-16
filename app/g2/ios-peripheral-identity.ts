import { classifyAdvertisement, g1FromName, hasEvenManufacturerSignature, type EvenAdvertisement } from './even-advertisement'
import { hexToBytes } from '../util/hex-util'

export type IosAdvertisement = { identifier: string; name: string; manufacturerData: string; rssi: number; connectable: boolean }
export type IosDevice = EvenAdvertisement & { identifier: string }

/**
 * A G1 arm advertises no full MAC, and CoreBluetooth hides the real one. Faceclaw's addresses are MAC-shaped everywhere, so its
 * address on this phone is made from the peripheral identifier. It's stable as long as the identifier is, which on firmware
 * 0.5.66 and later is across installs too, and it only has to mean something on this phone: nobody types it in.
 */
export function g1IosAddress(identifier: string): string {
  return identifier.replace(/-/g, '').slice(0, 12).toUpperCase().replace(/(..)(?=.)/g, '$1:')
}

/** Only a full vendor-advertised MAC may bind a manually entered address. */
export function identifyIosPeripheral(raw: IosAdvertisement): IosDevice | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw.identifier)) return null
  if (g1FromName(raw.name)) {
    const arm = classifyAdvertisement({ ...raw, address: g1IosAddress(raw.identifier), source: 'scan', bonded: false,
      txPower: null, seenAtMs: Date.now() })
    return arm && { ...arm, identifier: raw.identifier.toUpperCase() }
  }
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
