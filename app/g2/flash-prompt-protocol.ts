import { bytes, concat, integer, readBytes, readInteger, readString, type ProtocolMessage } from './ble-protocol'
const text = (field: number, value: string) => bytes(field, new Uint8Array(Array.from(value, ch => ch.charCodeAt(0))))
export function createFlashPrompt(magic: number, warning: string): Uint8Array {
  const geometry = (y: number, height: number, id: number, name: string) => concat(
    integer(1, 0), integer(2, y), integer(3, 280), integer(4, height), integer(9, id), text(10, name))
  const list = concat(geometry(150, 120, 2, 'flashmenu'), bytes(11, concat(integer(1, 2), integer(3, 1), text(4, 'No, cancel'), text(4, 'Yes, flash'))), integer(12, 1))
  const label = concat(geometry(0, 130, 1, 'flashwarn'), text(12, warning))
  return concat(integer(1, 0), integer(2, magic), bytes(3, concat(integer(1, 2), bytes(2, list), bytes(3, label), integer(5, 10000))))
}
export function flashPromptSelection(message: ProtocolMessage): boolean | null {
  if (message.sid !== 0xe0 || ![1, 6].includes(message.flag)) return null
  const event = readBytes(message.payload, 13), list = event && readBytes(event, 1)
  if (!list || readString(list, 2) !== 'flashmenu' || readInteger(list, 5, 0) !== 0) return null
  const index = readInteger(list, 4, -1), name = readString(list, 3).toLowerCase()
  if (index === 1 || name.startsWith('yes')) return true
  if (index === 0 || name.startsWith('no')) return false
  return null
}
