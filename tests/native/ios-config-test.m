#import <Foundation/Foundation.h>
#import "FaceclawConfigPort.h"
#include <assert.h>
static NSDictionary *send(NSString *dir, NSUserDefaults *defaults, NSString *domain, NSDictionary *request) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
    assert([json writeToFile:[dir stringByAppendingPathComponent:@"request.json"] atomically:YES]);
    [FaceclawConfigPort processDirectory:dir defaults:defaults domain:domain];
    assert(![NSFileManager.defaultManager fileExistsAtPath:[dir stringByAppendingPathComponent:@"request.json"]]);
    return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"response.json"]] options:0 error:nil];
}
int main(int argc, const char **argv) { @autoreleasepool {
    NSString *dir = [NSString stringWithUTF8String:argv[1]];
    NSString *domain = [@"com.faceclaw.config-test." stringByAppendingString:NSUUID.UUID.UUIDString];
    NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:domain];
    [defaults setPersistentDomain:@{@"keep":@"original", @"enabled":@NO} forName:domain];
    NSDictionary *input = @{@"terminal.connections":@"[{\"url\":\"g2mirror://test@host\"}]", @"enabled":@YES, @"empty":@"", @"number":@42, @"unicode":@"π & < \n 🔋"};
    NSDictionary *reply = send(dir, defaults, domain, @{@"id":@"1", @"operation":@"push", @"settings":input});
    assert([reply[@"ok"] boolValue] && [reply[@"count"] intValue] == 5);
    assert([[defaults persistentDomainForName:domain][@"keep"] isEqual:@"original"]);
    NSDictionary *backup = [NSDictionary dictionaryWithContentsOfFile:[dir stringByAppendingPathComponent:@"previous.plist"]];
    assert([backup[@"keep"] isEqual:@"original"] && ![backup[@"enabled"] boolValue]);
    reply = send(dir, defaults, domain, @{@"id":@"2", @"operation":@"pull"});
    assert([reply[@"id"] isEqual:@"2"] && [reply[@"ok"] boolValue]);
    NSDictionary *output = reply[@"config"][@"settings"];
    for (NSString *key in input) assert([output[key] isEqual:input[key]]);
    assert(!output[@"ios.settings.changeToken"]);
    NSDictionary *before = [defaults persistentDomainForName:domain];
    reply = send(dir, defaults, domain, @{@"id":@"3", @"operation":@"push", @"settings":@{@"keep":@"changed", @"invalid":@[]}});
    assert(![reply[@"ok"] boolValue]);
    assert([[defaults persistentDomainForName:domain] isEqual:before]);
    reply = send(dir, defaults, domain, @{@"id":@"4", @"operation":@"bad"});
    assert(![reply[@"ok"] boolValue]);
    [defaults removePersistentDomainForName:domain]; [defaults synchronize];
    puts("PASS: native config merges typed values, backs up, exports, consumes requests once and rejects invalid imports atomically");
} return 0; }
