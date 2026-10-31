#import "FaceclawResourceUsage.h"
#import <TargetConditionals.h>
#import <mach/mach.h>
#import <malloc/malloc.h>
#import <sys/resource.h>
#import <time.h>
#if TARGET_OS_IPHONE
#import <os/proc.h>
#endif

static NSNumber *kib(uint64_t bytes) { return @(bytes / 1024); }

@implementation FaceclawResourceUsage
+ (NSString *)sample {
    NSMutableDictionary *out = [NSMutableDictionary new];
    out[@"atMs"] = @(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1000000ULL);

    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage) == 0) {
        double seconds = (double)usage.ru_utime.tv_sec + (double)usage.ru_stime.tv_sec;
        double micros = (double)usage.ru_utime.tv_usec + (double)usage.ru_stime.tv_usec;
        out[@"cpuMs"] = @(seconds * 1000.0 + micros / 1000.0);
    }

    // The kernel fills as much of the struct as it knows and shrinks count to
    // match, so later-revision fields are read only when count covers them.
    task_vm_info_data_t vm;
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&vm, &count) == KERN_SUCCESS) {
        out[@"residentKb"] = kib(vm.resident_size);
        if (count >= TASK_VM_INFO_REV1_COUNT) out[@"footprintKb"] = kib(vm.phys_footprint);
        if (count >= TASK_VM_INFO_REV3_COUNT && vm.ledger_phys_footprint_peak > 0) {
            out[@"footprintPeakKb"] = kib((uint64_t)vm.ledger_phys_footprint_peak);
        }
    }

    malloc_statistics_t heap = {0};
    malloc_zone_statistics(NULL, &heap);
    out[@"mallocKb"] = kib(heap.size_in_use);

#if TARGET_OS_IPHONE
    out[@"availableKb"] = kib(os_proc_available_memory());
#endif

    thread_act_array_t threads = NULL;
    mach_msg_type_number_t threadCount = 0;
    if (task_threads(mach_task_self(), &threads, &threadCount) == KERN_SUCCESS) {
        for (mach_msg_type_number_t i = 0; i < threadCount; i++) mach_port_deallocate(mach_task_self(), threads[i]);
        vm_deallocate(mach_task_self(), (vm_address_t)threads, threadCount * sizeof(thread_act_t));
        out[@"threads"] = @(threadCount);
    }

    NSProcessInfo *process = NSProcessInfo.processInfo;
    out[@"thermalState"] = @(process.thermalState);
    out[@"lowPower"] = @(process.lowPowerModeEnabled);

    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"{}";
}
@end
