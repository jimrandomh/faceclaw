#import <Foundation/Foundation.h>
#import "FaceclawLoopbackRedirect.h"

/** GET a URL, pumping the main run loop (where the receiver delivers redirects) until it answers. */
static NSInteger get(NSString *url, NSString **body) {
    __block NSInteger status = -1;
    __block NSString *text = nil;
    __block BOOL done = NO;
    [[NSURLSession.sharedSession dataTaskWithURL:[NSURL URLWithString:url]
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            status = error ? -1 : ((NSHTTPURLResponse *)response).statusCode;
            text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
            done = YES;
        }] resume];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (body) *body = text;
    return status;
}

static void pumpBriefly(void) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        NSInteger port = argc > 1 ? atoi(argv[1]) : 43899;
        NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%ld", (long)port];
        FaceclawLoopbackRedirect *receiver = [FaceclawLoopbackRedirect new];
        NSMutableArray<NSString *> *redirects = [NSMutableArray array];
        receiver.redirectHandler = ^(NSString *url) { [redirects addObject:url]; };
        NSString *error = [receiver startOnPort:port path:@"/spotify-callback"];
        if (error) { NSLog(@"FAIL start: %@", error); return 1; }

        // A second listener on the same port reports the conflict instead of failing silently.
        FaceclawLoopbackRedirect *second = [FaceclawLoopbackRedirect new];
        NSString *conflict = [second startOnPort:port path:@"/spotify-callback"];
        if (!conflict || [conflict rangeOfString:@"port"].location == NSNotFound) { NSLog(@"FAIL conflict: %@", conflict); return 1; }

        // Other paths (a browser's favicon request) are refused and not reported.
        NSString *body = nil;
        if (get([base stringByAppendingString:@"/favicon.ico"], &body) != 404) { NSLog(@"FAIL favicon"); return 1; }
        pumpBriefly();
        if (redirects.count) { NSLog(@"FAIL favicon reported %@", redirects); return 1; }

        // The redirect itself: a page for the browser, the full URL (query intact) for the app.
        NSString *redirect = [base stringByAppendingString:@"/spotify-callback?code=AQB%2Fx-y_z&state=s1"];
        if (get(redirect, &body) != 200 || [body rangeOfString:@"return to Faceclaw"].location == NSNotFound) {
            NSLog(@"FAIL redirect page: %@", body); return 1;
        }
        pumpBriefly();
        if (redirects.count != 1 || ![redirects[0] isEqualToString:redirect]) { NSLog(@"FAIL redirect url %@", redirects); return 1; }

        // A query-less or prefixed path does not count as the redirect.
        if (get([base stringByAppendingString:@"/spotify-callback-extra?code=x"], NULL) != 404) { NSLog(@"FAIL prefix"); return 1; }

        // Once stopped, the port is free again.
        [receiver stop];
        pumpBriefly();
        if (get(redirect, NULL) != -1) { NSLog(@"FAIL still listening after stop"); return 1; }
        NSString *again = [second startOnPort:port path:@"/spotify-callback"];
        if (again) { NSLog(@"FAIL restart: %@", again); return 1; }
        [second stop];
        NSLog(@"PASS loopback redirect");
        return 0;
    }
}
