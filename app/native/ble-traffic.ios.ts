import { iosBleTraffic } from '../g2/ble-traffic-counters'
export type { BleTrafficSample } from './ble-traffic'
export function sampleBleTraffic(): { messages: number; bytes: number; frames: number } { return iosBleTraffic.sample() }
