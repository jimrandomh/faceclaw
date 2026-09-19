#import <Foundation/Foundation.h>
#import "FaceclawSseRequest.h"

int main(int argc, const char **argv) {
    @autoreleasepool {
        NSString *mode = [NSString stringWithUTF8String:argv[2]];
        FaceclawSseRequest *request = [[FaceclawSseRequest alloc] initWithURL:[NSString stringWithUTF8String:argv[1]]
            body:@"{\"test\":true}" headers:@"{\"Authorization\":\"Bearer fixture-key\",\"User-Agent\":\"Faceclaw-test\"}"];
        NSMutableArray *lines = [NSMutableArray new];
        NSDictionary *terminal = nil;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
        while (!terminal && deadline.timeIntervalSinceNow > 0) {
            NSArray *events = [NSJSONSerialization JSONObjectWithData:[[request takeEvents] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
            for (NSDictionary *event in events) {
                if ([event[@"kind"] isEqual:@"line"]) [lines addObject:event[@"text"]];
                else terminal = event;
            }
            if ([mode isEqual:@"cancel"] && lines.count) {
                [request cancel];
                [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.3]];
                if (![[request takeEvents] isEqual:@"[]"]) return 1;
                puts("PASS native SSE cancellation suppresses later callbacks"); return 0;
            }
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
        [request cancel];
        BOOL ok = NO;
        if ([mode isEqual:@"stream"]) ok = [terminal[@"kind"] isEqual:@"complete"] &&
            [lines isEqual:@[@"data: π 👓", @"", @": ping", @"data: last"]];
        if ([mode isEqual:@"error"]) ok = [terminal[@"kind"] isEqual:@"http-error"] &&
            [terminal[@"code"] intValue] == 401 && [terminal[@"text"] containsString:@"invalid_api_key"];
        if ([mode isEqual:@"redirect"]) ok = [terminal[@"kind"] isEqual:@"http-error"] && [terminal[@"code"] intValue] == 302;
        if ([mode isEqual:@"overflow"] || [mode isEqual:@"disconnect"]) ok = [terminal[@"kind"] isEqual:@"failure"];
        if (!ok) { NSLog(@"FAIL %@ lines=%@ terminal=%@", mode, lines, terminal); return 1; }
        printf("PASS native SSE %s\n", mode.UTF8String);
    }
    return 0;
}
