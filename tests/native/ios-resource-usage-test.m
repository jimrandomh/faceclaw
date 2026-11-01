#import <Foundation/Foundation.h>
#import <stdlib.h>
#import <string.h>
#import "FaceclawResourceUsage.h"

static NSDictionary *sample(void) {
    NSData *json = [[FaceclawResourceUsage sample] dataUsingEncoding:NSUTF8StringEncoding];
    return [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
}

#define CHECK(cond, ...) do { if (!(cond)) { NSLog(@"FAIL " __VA_ARGS__); return 1; } } while (0)

int main(void) {
    @autoreleasepool {
        NSDictionary *before = sample();
        CHECK([before isKindOfClass:NSDictionary.class], @"sample is not a JSON object");
        for (NSString *key in @[@"atMs", @"cpuMs", @"footprintKb", @"footprintPeakKb", @"residentKb", @"mallocKb",
                                @"threads", @"thermalState", @"lowPower"]) {
            CHECK([before[key] isKindOfClass:NSNumber.class], @"missing %@ in %@", key, before);
        }
        CHECK(before[@"availableKb"] == nil, @"os_proc_available_memory is iOS-only: %@", before);
        CHECK([before[@"footprintKb"] longLongValue] > 0 && [before[@"residentKb"] longLongValue] > 0, @"memory %@", before);
        CHECK([before[@"footprintPeakKb"] longLongValue] >= [before[@"footprintKb"] longLongValue], @"peak %@", before);
        CHECK([before[@"threads"] intValue] >= 1, @"threads %@", before);

        // Two busy threads alive at sampling time, ~150 ms of work between them;
        // 64 MiB of touched malloc memory.
        NSCondition *gate = [NSCondition new];
        __block BOOL release = NO;
        __block volatile double sink = 0;
        for (int t = 0; t < 2; t++) {
            [NSThread detachNewThreadWithBlock:^{
                NSDate *until = [NSDate dateWithTimeIntervalSinceNow:0.075];
                while (until.timeIntervalSinceNow > 0) for (int i = 0; i < 10000; i++) sink += i * 0.5;
                [gate lock]; while (!release) [gate wait]; [gate unlock];
            }];
        }
        size_t bytes = 64u << 20;
        char *block = malloc(bytes);
        memset(block, 1, bytes);
        [NSThread sleepForTimeInterval:0.2];

        NSDictionary *after = sample();
        long long elapsed = [after[@"atMs"] longLongValue] - [before[@"atMs"] longLongValue];
        double cpu = [after[@"cpuMs"] doubleValue] - [before[@"cpuMs"] doubleValue];
        CHECK(elapsed >= 190 && elapsed < 5000, @"monotonic clock advanced %lld ms over a 200 ms sleep", elapsed);
        CHECK(cpu >= 100, @"CPU advanced only %.1f ms over ~150 ms of busy work", cpu);
        CHECK([after[@"threads"] intValue] >= [before[@"threads"] intValue] + 2, @"threads %@ -> %@", before[@"threads"], after[@"threads"]);
        CHECK([after[@"mallocKb"] longLongValue] - [before[@"mallocKb"] longLongValue] >= 60 * 1024,
              @"malloc %@ -> %@ after 64 MiB", before[@"mallocKb"], after[@"mallocKb"]);
        CHECK([after[@"footprintKb"] longLongValue] - [before[@"footprintKb"] longLongValue] >= 60 * 1024,
              @"footprint %@ -> %@ after touching 64 MiB", before[@"footprintKb"], after[@"footprintKb"]);
        [gate lock]; release = YES; [gate broadcast]; [gate unlock];
        free(block);
        printf("PASS: resource sample reports footprint %lld KiB, malloc %lld KiB, %d threads, %.0f ms CPU over %lld ms\n",
               [after[@"footprintKb"] longLongValue], [after[@"mallocKb"] longLongValue], [after[@"threads"] intValue], cpu, elapsed);
    }
    return 0;
}
