#import <Foundation/Foundation.h>
#import "FaceclawConfigPort.h"
#import "FaceclawSettings.h"
#include <assert.h>
static NSDictionary *send(NSString *dir, NSUserDefaults *defaults, NSString *domain, NSDictionary *request) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
    assert([json writeToFile:[dir stringByAppendingPathComponent:@"request.json"] atomically:YES]);
    [FaceclawConfigPort processDirectory:dir defaults:defaults domain:domain];
    assert(![NSFileManager.defaultManager fileExistsAtPath:[dir stringByAppendingPathComponent:@"request.json"]]);
    return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"response.json"]] options:0 error:nil];
}
int main(int argc, const char **argv) { @autoreleasepool {
    NSString *library = [NSString stringWithUTF8String:argv[1]];
    NSString *dir = [library stringByAppendingPathComponent:@"FaceclawConfigPort"];
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *path = [library stringByAppendingPathComponent:@"faceclaw_settings.jsonc"];
    NSString *domain = [@"com.faceclaw.config-test." stringByAppendingString:NSUUID.UUID.UUIDString];
    NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:domain];
    [defaults setPersistentDomain:@{@"keep":@"original", @"enabled":@NO, @"teleprompter.recents":@"[]"} forName:domain];
    NSDictionary *input = @{@"terminal.connections":@"[{\"url\":\"g2mirror://test@host\"}]", @"enabled":@YES, @"empty":@"", @"number":@42, @"unicode":@"π & < \n 🔋"};
    NSDictionary *reply = send(dir, defaults, domain, @{@"id":@"1", @"operation":@"push", @"settings":input});
    assert([reply[@"ok"] boolValue] && [reply[@"count"] intValue] == 5);
    NSDictionary *backup = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[path stringByAppendingString:@".previous"]] options:0 error:nil];
    assert([backup[@"settings"][@"keep"] isEqual:@"original"] && ![backup[@"settings"][@"enabled"] boolValue]);
    // Existing JSON takes priority over subsequent changes to the legacy defaults.
    [defaults setPersistentDomain:@{@"keep":@"stale"} forName:domain];
    reply = send(dir, defaults, domain, @{@"id":@"2", @"operation":@"pull"});
    assert([reply[@"id"] isEqual:@"2"] && [reply[@"ok"] boolValue]);
    assert([reply[@"config"][@"schema"] intValue] == 2);
    NSDictionary *output = reply[@"config"][@"settings"];
    assert([output[@"keep"] isEqual:@"original"]);
    assert([output[@"terminal.connections"] isKindOfClass:NSArray.class]);
    assert([output[@"teleprompter.recents"] isEqual:@[]]);
    for (NSString *key in input) if (![key isEqual:@"terminal.connections"]) assert([output[key] isEqual:input[key]]);
    NSData *before = [NSData dataWithContentsOfFile:path];
    reply = send(dir, defaults, domain, @{@"id":@"3", @"operation":@"push", @"schema":@3, @"settings":@{@"keep":@"changed"}});
    assert(![reply[@"ok"] boolValue]);
    assert([[NSData dataWithContentsOfFile:path] isEqual:before]);
    reply = send(dir, defaults, domain, @{@"id":@"4", @"operation":@"push", @"settings":@{@"invalid":NSNull.null}});
    assert(![reply[@"ok"] boolValue]);
    assert([[NSData dataWithContentsOfFile:path] isEqual:before]);
    FaceclawSettings *store = [[FaceclawSettings alloc] initWithDirectory:library defaults:defaults domain:domain];
    [store setString:@"terminal.connections" value:@"[]"];
    [store setNumber:@"number" value:123.25];
    assert([store getNumber:@"number" fallback:0] == 123.25);
    [store remove:@"number"];
    assert([store getNumber:@"number" fallback:7] == 7);
    assert([store importConfig:@"// comment\n{\"schema\":2,\"settings\":{\"teleprompter.recents\":[],},}" merge:YES error:nil]);
    assert(![store importConfig:@"{\"schema\":99,\"settings\":{}}" merge:NO error:nil]);
    // Concurrent isolate-equivalent writes must not lose independent keys.
    dispatch_apply(20, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^(size_t n) {
        [store setString:[NSString stringWithFormat:@"worker.%zu", n] value:@"saved"];
    });
    FaceclawSettings *reloaded = [[FaceclawSettings alloc] initWithDirectory:library defaults:defaults domain:domain];
    for (int n = 0; n < 20; n++) assert(([[reloaded getString:[NSString stringWithFormat:@"worker.%d", n] fallback:@""] isEqual:@"saved"]));
    // Failed commits must not change what readers see in memory.
    NSData *saved = [NSData dataWithContentsOfFile:path];
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
    [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:NO attributes:nil error:nil];
    BOOL failedWrite = NO;
    @try { [store setString:@"keep" value:@"lost"]; }
    @catch (NSException *e) { failedWrite = YES; }
    assert(failedWrite && [[store getString:@"keep" fallback:@""] isEqual:@"original"]);
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
    [saved writeToFile:path atomically:YES];
    // Invalid files never fall back to old defaults or get overwritten.
    [@"{broken" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    BOOL rejected = NO;
    @try { (void)[[FaceclawSettings alloc] initWithDirectory:library defaults:defaults domain:domain]; }
    @catch (NSException *e) { rejected = YES; }
    assert(rejected);
    assert([[NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] isEqual:@"{broken"]);
    [defaults removePersistentDomainForName:domain]; [defaults synchronize];
    puts("PASS: native JSONC migration, atomic import, typed values, concurrent writes and invalid-file preservation");
} return 0; }
