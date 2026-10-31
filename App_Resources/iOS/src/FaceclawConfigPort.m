#import "FaceclawConfigPort.h"
#include <math.h>
// The app links FaceclawKit; tests/ios-config-native.cjs builds this file for macOS without it
// and supplies its own codec.
#if __has_include(<FaceclawKit/FaceclawKit.h>)
#import <FaceclawKit/FaceclawKit.h>
@interface FaceclawKitConfigCodec : NSObject <FaceclawConfigCodec>
@end
@implementation FaceclawKitConfigCodec
- (NSString *)exportValuesJson:(NSString *)valuesJson platform:(NSString *)platform appVersion:(NSString *)appVersion {
    return [FaceclawKitSettingsTransfer.shared exportValuesJson:valuesJson platform:platform appVersion:appVersion];
}
- (NSString *)importPlanDocument:(NSString *)document platform:(NSString *)platform {
    return [FaceclawKitSettingsTransfer.shared importPlanDocument:document platform:platform];
}
@end
#define FACECLAW_CONFIG_CODEC [FaceclawKitConfigCodec new]
#endif

static NSString *const kPlatform = @"ios";
static NSString *const kChangeToken = @"ios.settings.changeToken";

@implementation FaceclawConfigPort
+ (void)processPendingRequest {
#ifdef FACECLAW_CONFIG_CODEC
    NSString *library = NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES).firstObject;
    [self processDirectory:[library stringByAppendingPathComponent:@"FaceclawConfigPort"]
                  defaults:NSUserDefaults.standardUserDefaults domain:NSBundle.mainBundle.bundleIdentifier
                     codec:FACECLAW_CONFIG_CODEC
                appVersion:NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"]];
#endif
}
// Typed locals, not messages to id: FaceclawKit declares other `count`/`length` properties.
+ (BOOL)validSettings:(id)candidate {
    if (![candidate isKindOfClass:NSDictionary.class]) return NO;
    NSDictionary *settings = candidate;
    if (settings.count > 4096) return NO;
    for (id candidateKey in settings) {
        if (![candidateKey isKindOfClass:NSString.class]) return NO;
        NSString *key = candidateKey;
        id value = settings[key];
        if (!key.length || key.length > 512 ||
            !([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class])) return NO;
    }
    return YES;
}
/** The app's settings: strings and finite numbers (booleans included) in its persistent domain. */
+ (NSDictionary *)exportableSettings:(NSDictionary *)domain {
    NSMutableDictionary *settings = [NSMutableDictionary new];
    for (NSString *key in domain) {
        id value = domain[key];
        if ([value isKindOfClass:NSString.class] ||
            ([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]))) settings[key] = value;
    }
    [settings removeObjectForKey:kChangeToken];
    return settings;
}
+ (void)processDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain
                   codec:(id<FaceclawConfigCodec>)codec appVersion:(NSString *)appVersion {
    NSString *requestPath = [directory stringByAppendingPathComponent:@"request.json"];
    NSData *data = [NSData dataWithContentsOfFile:requestPath];
    if (!data) return;
    NSFileManager *fm = NSFileManager.defaultManager;
    // Consume once. A failed import must never be replayed at a later launch.
    [fm removeItemAtPath:requestPath error:nil];
    // A push embeds a document of up to 2 MiB as a JSON string, which escaping can enlarge.
    id request = data.length <= 8 * 1024 * 1024 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    BOOL valid = [request isKindOfClass:NSDictionary.class];
    NSString *identifier = valid && [request[@"id"] isKindOfClass:NSString.class] ? request[@"id"] : @"";
    NSMutableDictionary *reply = [@{@"id":identifier, @"ok":@NO, @"message":@"Invalid config request"} mutableCopy];
    [defaults synchronize];
    NSDictionary *before = [defaults persistentDomainForName:domain] ?: @{};
    if (valid && [request[@"operation"] isEqual:@"pull"]) {
        NSDictionary *settings = [self exportableSettings:before];
        NSData *values = [NSJSONSerialization dataWithJSONObject:settings options:0 error:nil];
        NSString *document = values ? [codec exportValuesJson:[[NSString alloc] initWithData:values encoding:NSUTF8StringEncoding]
                                                     platform:kPlatform appVersion:appVersion] : nil;
        if (document) {
            reply[@"ok"] = @YES; reply[@"message"] = @"Config exported";
            reply[@"document"] = document; reply[@"count"] = @(settings.count);
        } else reply[@"message"] = @"Could not encode settings";
    } else if (valid && [request[@"operation"] isEqual:@"push"] && [request[@"document"] isKindOfClass:NSString.class]) {
        NSData *planData = [[codec importPlanDocument:request[@"document"] platform:kPlatform] dataUsingEncoding:NSUTF8StringEncoding];
        id plan = planData ? [NSJSONSerialization JSONObjectWithData:planData options:0 error:nil] : nil;
        NSDictionary *settings = [plan isKindOfClass:NSDictionary.class] ? plan[@"settings"] : nil;
        if (![plan isKindOfClass:NSDictionary.class] || ![plan[@"ok"] isEqual:@YES]) {
            id message = [plan isKindOfClass:NSDictionary.class] ? plan[@"message"] : nil;
            reply[@"message"] = [message isKindOfClass:NSString.class] ? message : @"Invalid config";
        } else if (![self validSettings:settings]) {
            reply[@"message"] = @"Invalid config";
        } else {
            NSError *error = nil;
            NSData *backup = [NSPropertyListSerialization dataWithPropertyList:before format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
            if (backup && [backup writeToFile:[directory stringByAppendingPathComponent:@"previous.plist"] options:NSDataWritingAtomic error:&error]) {
                NSMutableDictionary *next = [before mutableCopy];
                [next addEntriesFromDictionary:settings];
                next[kChangeToken] = NSUUID.UUID.UUIDString;
                [defaults setPersistentDomain:next forName:domain];
                if ([defaults synchronize]) {
                    reply[@"ok"] = @YES; reply[@"message"] = @"Config imported";
                    reply[@"count"] = @(settings.count);
                    if ([plan[@"skipped"] isKindOfClass:NSArray.class]) reply[@"skipped"] = plan[@"skipped"];
                    if ([plan[@"sourcePlatform"] isKindOfClass:NSString.class]) reply[@"sourcePlatform"] = plan[@"sourcePlatform"];
                } else {
                    [defaults setPersistentDomain:before forName:domain]; [defaults synchronize];
                    reply[@"message"] = @"Could not persist config; restored previous settings";
                }
            } else reply[@"message"] = @"Could not back up existing settings; import skipped";
        }
    }
    NSData *response = [NSJSONSerialization dataWithJSONObject:reply options:NSJSONWritingPrettyPrinted error:nil];
    [response writeToFile:[directory stringByAppendingPathComponent:@"response.json"] options:NSDataWritingAtomic error:nil];
}
@end
