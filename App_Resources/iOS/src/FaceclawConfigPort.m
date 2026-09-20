#import "FaceclawConfigPort.h"
#import "FaceclawSettings.h"
@implementation FaceclawConfigPort
+ (void)processPendingRequest {
    NSString *library = NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES).firstObject;
    [self processDirectory:[library stringByAppendingPathComponent:@"FaceclawConfigPort"] store:FaceclawSettings.shared];
}
+ (void)processDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain {
    FaceclawSettings *store = [[FaceclawSettings alloc] initWithDirectory:[directory stringByDeletingLastPathComponent] defaults:defaults domain:domain];
    [self processDirectory:directory store:store];
}
+ (void)processDirectory:(NSString *)directory store:(FaceclawSettings *)store {
    NSString *requestPath = [directory stringByAppendingPathComponent:@"request.json"];
    NSData *data = [NSData dataWithContentsOfFile:requestPath];
    if (!data) return;
    // Consume once, including invalid requests.
    [NSFileManager.defaultManager removeItemAtPath:requestPath error:nil];
    id request = data.length <= 2 * 1024 * 1024 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    BOOL valid = [request isKindOfClass:NSDictionary.class];
    NSString *identifier = valid && [request[@"id"] isKindOfClass:NSString.class] ? request[@"id"] : @"";
    NSMutableDictionary *reply = [@{@"id":identifier, @"ok":@NO, @"message":@"Invalid config request"} mutableCopy];
    if (valid && [request[@"operation"] isEqual:@"pull"]) {
        reply[@"config"] = [NSJSONSerialization JSONObjectWithData:[[store exportConfig] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        reply[@"ok"] = @YES; reply[@"message"] = @"Config exported";
    } else if (valid && [request[@"operation"] isEqual:@"push"] && [request[@"settings"] isKindOfClass:NSDictionary.class]) {
        // Old host scripts omit schema; their payloads use schema 1.
        NSDictionary *config = @{@"schema":request[@"schema"] ?: @1, @"settings":request[@"settings"]};
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:config options:0 error:nil];
        NSError *error = nil;
        if ([store importConfig:[[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding] merge:YES error:&error]) {
            reply[@"ok"] = @YES; reply[@"message"] = @"Config imported";
            reply[@"count"] = @([request[@"settings"] count]);
        } else reply[@"message"] = error.localizedDescription ?: @"Could not import config";
    }
    NSData *response = [NSJSONSerialization dataWithJSONObject:reply options:NSJSONWritingPrettyPrinted error:nil];
    [response writeToFile:[directory stringByAppendingPathComponent:@"response.json"] options:NSDataWritingAtomic error:nil];
}
@end
