import { bytes, concat, integer } from './ble-protocol'

/** Same G2SettingPackage as Kotlin BleProtocol.buildSetBrightness. */
export function setBrightness(magic: number, level: number | null): Uint8Array {
  const fields = level === null ? integer(1, 1)
    : concat(integer(1, 0), integer(2, Math.max(0, Math.min(100, Math.round(level)))))
  return concat(integer(1, 1), integer(2, magic), bytes(3, bytes(1, fields)))
}
