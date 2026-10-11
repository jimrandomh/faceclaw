#import <Foundation/Foundation.h>
#import "FaceclawSocket.h"
/** Drains the socket's events until it closes; handler returns NO to stop early. */
static void pump(FaceclawSocket *socket, BOOL (^handler)(NSDictionary *event)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (deadline.timeIntervalSinceNow > 0) {
        NSArray *events = [NSJSONSerialization JSONObjectWithData:[[socket takeEvents] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        for (NSDictionary *event in events) if (!handler(event)) return;
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        NSString *url = [NSString stringWithUTF8String:argv[1]];
        FaceclawSocket *socket = [[FaceclawSocket alloc] initWithURL:url headerName:@"X-Faceclaw-Key" headerValue:@"secret"];
        __block BOOL opened = NO, binary = NO, echoed = NO, closed = NO;
        pump(socket, ^BOOL(NSDictionary *event) {
            NSString *kind = event[@"kind"];
            if ([kind isEqual:@"open"]) { opened = YES; const uint8_t bytes[] = {1, 2, 255}; [socket sendData:[NSData dataWithBytes:bytes length:3]]; }
            if ([kind isEqual:@"text"] && [event[@"text"] isEqual:@"binary:0102ff"]) { binary = YES; [socket sendText:@"Faceclaw echo: π 🔋"]; }
            if ([kind isEqual:@"text"] && [event[@"text"] isEqual:@"Faceclaw echo: π 🔋"]) echoed = YES;
            if ([kind isEqual:@"closed"] || [kind isEqual:@"error"]) { closed = YES; return NO; }
            return YES;
        });
        [socket close];
        if (!opened || !binary || !echoed || !closed) { NSLog(@"FAIL open=%d binary=%d echo=%d close=%d", opened, binary, echoed, closed); return 1; }
        // Without the header the server refuses the handshake; the error names the status.
        FaceclawSocket *refused = [[FaceclawSocket alloc] initWithURL:url];
        __block NSString *error = nil;
        pump(refused, ^BOOL(NSDictionary *event) {
            if ([event[@"kind"] isEqual:@"error"]) { error = event[@"text"]; return NO; }
            return YES;
        });
        [refused close];
        if (![error containsString:@"HTTP 401"]) { NSLog(@"FAIL refused handshake error=%@", error); return 1; }
        puts("PASS: native WebSocket sends a handshake header, binary and UTF-8 frames, reports close and refused status");
    }
    return 0;
}
