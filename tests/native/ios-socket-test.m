#import <Foundation/Foundation.h>
#import "FaceclawSocket.h"
int main(int argc, const char **argv) {
    @autoreleasepool {
        FaceclawSocket *socket = [[FaceclawSocket alloc] initWithURL:[NSString stringWithUTF8String:argv[1]]];
        BOOL opened = NO, echoed = NO, closed = NO;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
        while (!closed && deadline.timeIntervalSinceNow > 0) {
            NSArray *events = [NSJSONSerialization JSONObjectWithData:[[socket takeEvents] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
            for (NSDictionary *event in events) {
                NSString *kind = event[@"kind"];
                if ([kind isEqual:@"open"]) { opened = YES; [socket sendText:@"Faceclaw echo: π 🔋"]; }
                if ([kind isEqual:@"text"]) echoed = [event[@"text"] isEqual:@"Faceclaw echo: π 🔋"];
                if ([kind isEqual:@"closed"] || [kind isEqual:@"error"]) closed = YES;
            }
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
        [socket close];
        if (!opened || !echoed || !closed) { NSLog(@"FAIL open=%d echo=%d close=%d", opened, echoed, closed); return 1; }
        puts("PASS: native WebSocket opens, echoes UTF-8 and reports close");
    }
    return 0;
}
