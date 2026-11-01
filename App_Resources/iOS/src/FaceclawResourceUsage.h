#import <Foundation/Foundation.h>

/** Lightweight process counters for the on-glasses resource-usage monitor. */
@interface FaceclawResourceUsage : NSObject
/**
 * One sample as a JSON object: atMs (monotonic clock, counting sleep), cpuMs
 * (user+system time of every thread, alive or exited), footprintKb (the
 * phys_footprint that jetsam limits and Xcode's memory gauge shows),
 * footprintPeakKb (lifetime peak), residentKb, mallocKb (bytes in use across
 * malloc zones), availableKb (headroom before the jetsam limit; 0 when there
 * is none, as on the simulator), threads, thermalState
 * (NSProcessInfoThermalState) and lowPower. Fields whose query fails are
 * omitted.
 */
+ (NSString *)sample;
@end
