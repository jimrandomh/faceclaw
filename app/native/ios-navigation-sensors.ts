import { LocationTracker } from './location-tracker.ios'
import { ensureFineLocationPermission } from './location-permissions.ios'
import { addCompassListener, setCompassEnabled } from './compass.ios'
import { getDeclinationDegrees, refreshDeclination } from '../apps/compass/declination'
import { type NavigationSensorEvent, type NavigationSensorRequest } from '../apps/navigate/navigation-sensors-messages'

/** Core Location stays on main; the shared Navigate worker receives only JSON. */
export class IosNavigationSensors {
  private generation = 0
  private id = 0
  private tracker: LocationTracker | null = null
  private offCompass: (() => void) | null = null
  private readonly owner = 'worker:navigate'
  constructor(private readonly reply: (event: NavigationSensorEvent) => void) {}
  handle(request: NavigationSensorRequest): void {
    if (request.action === 'compass') {
      if (request.enabled && !this.offCompass) {
        refreshDeclination()
        this.offCompass = addCompassListener(event => this.reply({ kind: 'compass', event, declination: getDeclinationDegrees() }))
      } else if (!request.enabled) { this.offCompass?.(); this.offCompass = null }
      setCompassEnabled(request.enabled, this.owner)
    } else if (request.action === 'stop') {
      if (request.id === this.id) this.stopLocation()
    } else {
      this.stopLocation(); this.id = request.id
      const generation = this.generation
      void ensureFineLocationPermission().then(granted => {
        if (generation !== this.generation) return
        if (!granted) throw new Error('Precise location is required for navigation. Enable it in the phone’s Settings, then retry.')
        refreshDeclination()
        this.tracker = new LocationTracker({
          onLocation: location => {
            if (generation === this.generation) this.reply({ kind: 'location', id: request.id, location })
          },
          onError: message => {
            if (generation !== this.generation) return
            this.stopLocation(); this.reply({ kind: 'error', id: request.id, message })
          },
        })
        this.tracker.start(request.intervalMs)
      }).catch(error => {
        if (generation !== this.generation) return
        this.stopLocation(); this.reply({ kind: 'error', id: request.id, message: String(error.message ?? error) })
      })
    }
  }
  private stopLocation(): void {
    ++this.generation; this.id = 0
    this.tracker?.stop(); this.tracker = null
  }
  stop(): void {
    this.stopLocation()
    this.offCompass?.(); this.offCompass = null
    setCompassEnabled(false, this.owner)
  }
}
