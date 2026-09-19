import { bytes, concat, integer, readBytes, readInteger, type ProtocolMessage } from './ble-protocol'

// Matches BleProtocol.buildSetWearDetection/buildFaceclawWakeControl on Android.
export const enableWearDetection = (magic: number): Uint8Array => concat(
  integer(1, 1), integer(2, magic), bytes(3, bytes(5, integer(1, 1))))
export const queryWearState = (): Uint8Array => concat(
  integer(1, 1), integer(2, 0), bytes(101, new Uint8Array([70, 67, 1, 7, 0, 0])))

export function decodeWearState(message: ProtocolMessage): boolean | null {
  if (message.sid !== 0x10 || message.command !== 3) return null
  const event = readBytes(message.payload, 5)
  if (!event || readInteger(event, 1, -1) !== 1) return null
  const state = readInteger(event, 2, -1)
  return state === 0 ? false : state === 1 ? true : null
}
