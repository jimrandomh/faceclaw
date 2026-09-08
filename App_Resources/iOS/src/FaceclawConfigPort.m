#import "FaceclawConfigPort.h"
@implementation FaceclawConfigPort
+ (void)processPendingRequest {
    NSString *library = NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES).firstObject;
    [self processDirectory:[library stringByAppendingPathComponent:@"FaceclawConfigPort"]
                 defaults:NSUserDefaults.standardUserDefaults domain:NSBundle.mainBundle.bundleIdentifier];
}
+ (BOOL)validSettings:(id)settings {
    if (![settings isKindOfClass:NSDictionary.class] || [settings count] > 4096) return NO;
    for (id key in settings) {
        id value = settings[key];
        if (![key isKindOfClass:NSString.class] || ![key length] || [key length] > 512 ||
            !([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class])) return NO;
    }
    return YES;
}
+ (void)processDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain {
    NSString *requestPath = [directory stringByAppendingPathComponent:@"request.json"];
    NSData *data = [NSData dataWithContentsOfFile:requestPath];
    if (!data) return;
    NSFileManager *fm = NSFileManager.defaultManager;
    // Consume once. A failed import must never be replayed at a later launch.
    [fm removeItemAtPath:requestPath error:nil];
    id request = data.length <= 2 * 1024 * 1024 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    BOOL valid = [request isKindOfClass:NSDictionary.class];
    NSString *identifier = valid && [request[@"id"] isKindOfClass:NSString.class] ? request[@"id"] : @"";
    NSMutableDictionary *reply = [@{@"id":identifier, @"ok":@NO, @"message":@"Invalid config request"} mutableCopy];
    [defaults synchronize];
    NSDictionary *before = [defaults persistentDomainForName:domain] ?: @{};
    if (valid && [request[@"operation"] isEqual:@"pull"]) {
        NSMutableDictionary *settings = [NSMutableDictionary new];
        for (NSString *key in before) {
            id value = before[key];
            if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) settings[key] = value;
        }
        [settings removeObjectForKey:@"ios.settings.changeToken"];
        reply[@"config"] = @{@"schema":@1, @"settings":settings}; reply[@"ok"] = @YES;
        reply[@"message"] = @"Config exported";
    } else if (valid && [request[@"operation"] isEqual:@"push"] && [self validSettings:request[@"settings"]]) {
        NSError *error = nil;
        NSData *backup = [NSPropertyListSerialization dataWithPropertyList:before format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
        if (backup && [backup writeToFile:[directory stringByAppendingPathComponent:@"previous.plist"] options:NSDataWritingAtomic error:&error]) {
            NSMutableDictionary *next = [before mutableCopy];
            [next addEntriesFromDictionary:request[@"settings"]];
            next[@"ios.settings.changeToken"] = NSUUID.UUID.UUIDString;
            [defaults setPersistentDomain:next forName:domain];
            if ([defaults synchronize]) {
                reply[@"ok"] = @YES; reply[@"message"] = @"Config imported";
                reply[@"count"] = @([request[@"settings"] count]);
            } else {
                [defaults setPersistentDomain:before forName:domain]; [defaults synchronize];
                reply[@"message"] = @"Could not persist config; restored previous settings";
            }
        } else reply[@"message"] = @"Could not back up existing settings; import skipped";
    }
    NSData *response = [NSJSONSerialization dataWithJSONObject:reply options:NSJSONWritingPrettyPrinted error:nil];
    [response writeToFile:[directory stringByAppendingPathComponent:@"response.json"] options:NSDataWritingAtomic error:nil];
}
@end
