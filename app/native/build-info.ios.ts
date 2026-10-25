import type { BuildKind } from './build-info'

declare const NSBundle: any
declare const NSProcessInfo: any

let cached: BuildKind | null = null

/**
 * App Store (and TestFlight) builds carry no provisioning profile; anything
 * installed from Xcode or as an ad hoc build does. Simulator builds have none
 * either, so they're recognized by the simulator's environment.
 */
export function buildKind(): BuildKind {
  if (cached) return cached
  if (NSProcessInfo.processInfo.environment.objectForKey('SIMULATOR_DEVICE_NAME')) cached = 'debug'
  else if (NSBundle.mainBundle.pathForResourceOfType('embedded', 'mobileprovision')) cached = 'self-built'
  else cached = 'official'
  return cached
}
