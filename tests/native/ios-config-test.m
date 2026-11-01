#import <Foundation/Foundation.h>
#import "FaceclawConfigPort.h"
#include <assert.h>
#include <math.h>

static NSString *jsonText(id object) {
    return [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:object options:0 error:nil] encoding:NSUTF8StringEncoding];
}
static id parse(NSString *text) {
    return [NSJSONSerialization JSONObjectWithData:[text dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}

/** Stands in for Kotlin SettingsTransfer (tested in tests/kotlin): wraps and unwraps values. */
@interface StubCodec : NSObject <FaceclawConfigCodec>
@property NSString *lastAppVersion;
@property NSDictionary *forcedPlan;
@end
@implementation StubCodec
- (NSString *)exportValuesJson:(NSString *)valuesJson platform:(NSString *)platform appVersion:(NSString *)appVersion {
    self.lastAppVersion = appVersion;
    return jsonText(@{@"schema":@2, @"platform":platform, @"settings":parse(valuesJson)});
}
- (NSString *)importPlanDocument:(NSString *)document platform:(NSString *)platform {
    if (self.forcedPlan) return jsonText(self.forcedPlan);
    NSDictionary *doc = parse(document);
    if (![doc[@"schema"] isEqual:@2]) return jsonText(@{@"ok":@NO, @"message":@"Unsupported config schema"});
    return jsonText(@{@"ok":@YES, @"settings":doc[@"settings"], @"skipped":@[@"deviceAddress.left"], @"sourcePlatform":@"android"});
}
@end

static NSDictionary *send(NSString *dir, NSUserDefaults *defaults, NSString *domain, StubCodec *codec, NSDictionary *request) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
    assert([json writeToFile:[dir stringByAppendingPathComponent:@"request.json"] atomically:YES]);
    [FaceclawConfigPort processDirectory:dir defaults:defaults domain:domain codec:codec appVersion:@"1.2.3"];
    assert(![NSFileManager.defaultManager fileExistsAtPath:[dir stringByAppendingPathComponent:@"request.json"]]);
    return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"response.json"]] options:0 error:nil];
}

int main(int argc, const char **argv) { @autoreleasepool {
    NSString *dir = [NSString stringWithUTF8String:argv[1]];
    NSString *domain = [@"com.faceclaw.config-test." stringByAppendingString:NSUUID.UUID.UUIDString];
    NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:domain];
    StubCodec *codec = [StubCodec new];
    [defaults setPersistentDomain:@{@"keep":@"original", @"enabled":@NO, @"notANumber":@(NAN)} forName:domain];
    NSDictionary *input = @{@"terminal.connections":@"[{\"url\":\"g2mirror://test@host\"}]", @"enabled":@YES, @"empty":@"", @"number":@42, @"unicode":@"π & < \n 🔋"};
    NSDictionary *reply = send(dir, defaults, domain, codec, @{@"id":@"1", @"operation":@"push",
                                                               @"document":jsonText(@{@"schema":@2, @"settings":input})});
    assert([reply[@"ok"] boolValue] && [reply[@"count"] intValue] == 5);
    assert([reply[@"skipped"] isEqual:@[@"deviceAddress.left"]] && [reply[@"sourcePlatform"] isEqual:@"android"]);
    NSDictionary *stored = [defaults persistentDomainForName:domain];
    assert([stored[@"keep"] isEqual:@"original"]);
    assert(stored[@"enabled"] == (id)kCFBooleanTrue && [stored[@"number"] isEqual:@42]);
    NSDictionary *backup = [NSDictionary dictionaryWithContentsOfFile:[dir stringByAppendingPathComponent:@"previous.plist"]];
    assert([backup[@"keep"] isEqual:@"original"] && ![backup[@"enabled"] boolValue]);

    reply = send(dir, defaults, domain, codec, @{@"id":@"2", @"operation":@"pull"});
    assert([reply[@"id"] isEqual:@"2"] && [reply[@"ok"] boolValue]);
    assert([codec.lastAppVersion isEqual:@"1.2.3"]);
    NSDictionary *document = parse(reply[@"document"]);
    assert([document[@"platform"] isEqual:@"ios"]);
    NSDictionary *output = document[@"settings"];
    for (NSString *key in input) assert([output[key] isEqual:input[key]]);
    assert([output[@"keep"] isEqual:@"original"] && [reply[@"count"] intValue] == (int)output.count);
    assert(!output[@"ios.settings.changeToken"] && !output[@"notANumber"]);

    NSDictionary *before = [defaults persistentDomainForName:domain];
    reply = send(dir, defaults, domain, codec, @{@"id":@"3", @"operation":@"push", @"document":jsonText(@{@"schema":@9, @"settings":@{}})});
    assert(![reply[@"ok"] boolValue] && [reply[@"message"] isEqual:@"Unsupported config schema"]);
    codec.forcedPlan = @{@"ok":@YES, @"settings":@{@"keep":@"changed", @"invalid":@[]}};
    reply = send(dir, defaults, domain, codec, @{@"id":@"4", @"operation":@"push", @"document":@"{}"});
    assert(![reply[@"ok"] boolValue]);
    codec.forcedPlan = nil;
    // Requests from older scripts sent pre-converted settings rather than a document.
    reply = send(dir, defaults, domain, codec, @{@"id":@"5", @"operation":@"push", @"settings":@{@"keep":@"changed"}});
    assert(![reply[@"ok"] boolValue]);
    assert([[defaults persistentDomainForName:domain] isEqual:before]);
    reply = send(dir, defaults, domain, codec, @{@"id":@"6", @"operation":@"bad"});
    assert(![reply[@"ok"] boolValue]);
    [defaults removePersistentDomainForName:domain]; [defaults synchronize];
    puts("PASS: native config merges typed values, backs up, exports, consumes requests once and rejects invalid imports atomically");
} return 0; }
