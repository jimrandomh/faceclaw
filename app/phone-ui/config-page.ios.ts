import { Button, Color, GridLayout, Label, Page, ScrollView, StackLayout, TextField } from '@nativescript/core'
import { loadDeviceAddresses, normalizeMacAddress, saveDeviceAddresses } from '../g2/device-addresses'
import { deviceAddressError, type IosDevice } from '../g2/ios-peripheral-identity'
import { iosBluetooth } from '../native/ios-bluetooth'

export function createConfigureDevicesPage(): Page {
  const page = new Page(); page.actionBarHidden = true
  const root = new GridLayout(); root.rows = 'auto,*,auto'; root.padding = 16; page.content = root
  const title = new Label(); title.text = 'Configure devices'; title.fontSize = 24; title.fontWeight = 'bold'; root.addChild(title)
  const scroll = new ScrollView(); GridLayout.setRow(scroll, 1); root.addChild(scroll)
  const form = new StackLayout(); scroll.content = form
  const text = (value: string, size = 15) => {
    const label = new Label(); label.text = value; label.fontSize = size; label.textWrap = true; label.marginTop = 12; form.addChild(label); return label
  }
  text('Enter the G2 arm MAC addresses and optional R1 ring address. Scan once so this iPhone can find the matching devices. Saving does not connect.')
  const stored = loadDeviceAddresses()
  const fields = {} as Record<'left' | 'right' | 'ring', TextField>
  for (const role of ['right', 'left', 'ring'] as const) {
    text(role === 'ring' ? 'R1 ring MAC (optional)' : `${role === 'left' ? 'Left' : 'Right'} arm MAC`)
    const field = new TextField(); field.text = stored[role]; field.hint = 'AA:BB:CC:DD:EE:FF'
    field.autocorrect = false; field.autocapitalizationType = 'allcharacters'; field.fontSize = 18
    field.padding = 10; field.backgroundColor = new Color('#ffffff'); field.accessibilityLabel = `${role} MAC address`
    field.accessibilityIdentifier = `device-address-${role}`; form.addChild(field); fields[role] = field
  }
  const status = text('Addresses are saved only when you tap Save.'); status.color = new Color('#285c45')
  const button = (label: string, action: () => void) => {
    const view = new Button(); view.text = label; view.fontSize = 15; view.marginTop = 12; view.on('tap', action); return view
  }
  let off: (() => void) | null = null
  let closed = false
  const found = new StackLayout()
  const rows = new Map<string, Button>()
  const showDevice = (device: IosDevice) => {
    if (device.connectable === false) return
    let row = rows.get(device.address)
    if (!row) {
      row = button('', () => { fields[device.role].text = device.address; status.text = `${device.role} address selected. Tap Save to keep it.` })
      row.textWrap = true; row.fontSize = 13; rows.set(device.address, row); found.addChild(row)
    }
    row.text = `${device.role === 'ring' ? 'Ring' : device.role === 'left' ? 'Left arm' : 'Right arm'} · ${device.address}\n${device.serial || device.name} · ${device.rssi ?? '?'} dBm`
  }
  const scan = button('Scan for devices', () => {
    for (const field of Object.values(fields)) field.dismissSoftInput()
    const ble = iosBluetooth()
    off?.(); off = ble.onEvent(event => {
      if (closed) return
      if (event.kind === 'device' && 'device' in event) showDevice(event.device)
      if (event.kind === 'scan-stopped') { scan.isEnabled = true; status.text = rows.size ? 'Tap a device to fill its address, then Save.' : 'No matching devices found. Wake the glasses and disconnect other apps, then scan again.' }
    })
    rows.clear(); found.removeChildren(); scan.isEnabled = false; status.text = 'Scanning… Allow Bluetooth if iOS asks.'
    void ble.startScan().catch(error => { if (!closed) { status.text = String(error.message ?? error); scan.isEnabled = true } })
  })
  form.addChild(scan); form.addChild(found)
  const footer = new GridLayout(); footer.columns = '*,*'; GridLayout.setRow(footer, 2); root.addChild(footer)
  const close = () => { closed = true; off?.(); off = null; iosBluetooth().stopScan(); page.closeModal() }
  const back = button('Back', close); footer.addChild(back)
  const save = button('Save', () => {
    const addresses = { right: normalizeMacAddress(fields.right.text), left: normalizeMacAddress(fields.left.text), ring: normalizeMacAddress(fields.ring.text) }
    const error = deviceAddressError(addresses)
    if (error) { status.text = error; return }
    saveDeviceAddresses(addresses)
    for (const role of ['left', 'right', 'ring'] as const) { fields[role].text = addresses[role]; fields[role].dismissSoftInput() }
    status.text = 'Saved device addresses. Return to the main screen and choose Connect.'
  })
  GridLayout.setColumn(save, 1); footer.addChild(save)
  page.on('unloaded', () => { closed = true; off?.(); off = null; iosBluetooth().stopScan() })
  return page
}
