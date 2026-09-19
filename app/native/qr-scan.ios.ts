declare const FaceclawQrScanner: any

let activeScanner: any = null

export function isQrScannerAvailable(): boolean { return FaceclawQrScanner.isAvailable() }

export function scanQrCode(): Promise<string | null> {
  if (activeScanner) return Promise.reject(new Error('A QR scan is already open.'))
  return new Promise((resolve, reject) => {
    const scanner = FaceclawQrScanner.new()
    activeScanner = scanner
    let settled = false
    const finish = (text: string | null, error: string | null) => {
      if (settled) return
      settled = true
      if (activeScanner === scanner) activeScanner = null
      error ? reject(new Error(String(error))) : resolve(text == null ? null : String(text))
    }
    try { scanner.startWithCompletion(finish) }
    catch (error) { finish(null, String(error)) }
  })
}

export function cancelQrScan(): void { activeScanner?.cancel() }
