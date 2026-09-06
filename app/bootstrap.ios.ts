import { Application, Button, Device, Label, Page, ScrollView, StackLayout } from '@nativescript/core'
import { bytesToHex, hexToBytes } from './util/hex-util'

// Milestone 1: exercise native UI, TypeScript, and an existing shared utility
// without loading the Android services used by the full glasses application.
Application.run({
  create: () => {
    const page = new Page()
    page.actionBarHidden = true
    const scroll = new ScrollView()
    const content = new StackLayout()
    content.padding = 28
    content.verticalAlignment = 'middle'

    const label = (text: string, fontSize = 17) => {
      const view = new Label()
      view.text = text
      view.fontSize = fontSize
      view.textWrap = true
      view.marginBottom = 20
      content.addChild(view)
      return view
    }

    label('Faceclaw', 36)
    label('iOS port · First launch', 24)
    label(`NativeScript is running on ${Device.model} (iOS ${Device.osVersion}).`)
    label('Glasses pairing and the Android features are still to be ported.')
    const status = label('Tap below to test native input and shared TypeScript code.')
    const button = new Button()
    button.text = 'Run shared-code check'
    button.accessibilityIdentifier = 'shared-code-check'
    let checks = 0
    button.on('tap', () => {
      const result = bytesToHex(hexToBytes('46 61 63 65 63 6c 61 77'))
      const passed = result === '46616365636C6177'
      checks += 1
      status.text = `${passed ? 'Passed' : 'Failed'} · Check ${checks}\nShared hex utilities returned ${result}.`
      console.log(`[ios-bootstrap] Shared-code check ${checks}: ${passed ? 'PASS' : 'FAIL'} (${result})`)
    })
    content.addChild(button)
    scroll.content = content
    page.content = scroll
    page.on('loaded', () => console.log('[ios-bootstrap] Faceclaw launch screen loaded'))
    return page
  },
})
