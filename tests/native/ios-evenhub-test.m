#import <UIKit/UIKit.h>
#import "FaceclawEvenHubWebView.h"
#import "FaceclawCrypto.h"

@interface Probe : UIResponder <UIApplicationDelegate>
@property(nonatomic) UIWindow *window;
@property(nonatomic) FaceclawEvenHubWebView *host;
@property(nonatomic) NSMutableSet *seen;
@property(nonatomic) NSInteger phase;
@property(nonatomic) UIBackgroundTaskIdentifier backgroundTask;
@property(nonatomic) NSInteger backgroundIntervals;
@property(nonatomic) BOOL foregroundPassed;
@end
@implementation Probe
- (void)writeResult:(NSDictionary *)result name:(NSString *)name {
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    NSString *documents = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    [data writeToFile:[documents stringByAppendingPathComponent:name] atomically:YES];
}
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.backgroundTask = UIBackgroundTaskInvalid;
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [UIViewController new];
    self.window.rootViewController.view.backgroundColor = UIColor.whiteColor;
    [self.window makeKeyAndVisible];
    self.seen = [NSMutableSet new]; self.host = [FaceclawEvenHubWebView new]; self.phase = 1;
    NSString *package = NSUUID.UUID.UUIDString;
    self.host.packageIdentifier = package;
    __weak Probe *weakSelf = self;
    self.host.eventHandler = ^(NSString *json) {
        NSLog(@"EHPROBE %@", json);
        NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        if ([event[@"kind"] isEqual:@"error"] && [event[@"message"] containsString:@"outside the app origin"])
            [weakSelf.seen addObject:@"blocked-navigation"];
        if ([event[@"kind"] isEqual:@"call"]) {
            [weakSelf.seen addObject:event[@"name"]];
            [weakSelf.seen addObject:[NSString stringWithFormat:@"%ld:%@", (long)weakSelf.phase, event[@"name"]]];
            [weakSelf.host evaluate:[NSString stringWithFormat:@"window.__fcResolve(%@,true,true)", event[@"id"]]];
            if (UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) {
                [weakSelf.seen addObject:[@"background:" stringByAppendingString:event[@"name"]]];
                if ([event[@"name"] isEqual:@"interval"]) weakSelf.backgroundIntervals++;
            }
            if (weakSelf.phase == 6 && [event[@"name"] isEqual:@"timer"])
                [weakSelf writeResult:@{@"ready": @YES} name:@"background-ready.json"];
        }
    };
    NSString *root = NSBundle.mainBundle.resourcePath;
    NSString *script = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"bridge.js"] encoding:NSUTF8StringEncoding error:nil];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.host start:[root stringByAppendingPathComponent:@"dist"] entrypoint:@"index.html" script:script];
    });
    for (NSInteger phase = 2; phase <= 5; phase++) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (phase - 1) * 4 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            void (^handler)(NSString *) = self.host.eventHandler;
            [self.host showOnPhone]; [self.host hideOnPhone]; [self.host destroy];
            self.phase = phase; self.host = [FaceclawEvenHubWebView new];
            self.host.eventHandler = handler;
            self.host.packageIdentifier = phase == 2 ? package : [package stringByAppendingString:@".other"];
            if (phase <= 3) [self.host start:[root stringByAppendingPathComponent:@"dist"] entrypoint:@"index.html" script:script];
            else {
                NSString *url = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"remote.txt"] encoding:NSUTF8StringEncoding error:nil];
                [self.host startURL:phase == 5 ? [url stringByAppendingString:@"redirect"] : url script:script];
            }
        });
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 21 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSArray *required = @[@"early", @"module", @"fetch", @"image", @"timer", @"raf", @"wasm", @"traversal", @"1:stored", @"2:restored", @"3:stored", @"4:early", @"4:module", @"4:fetch", @"4:timer", @"blocked-navigation"];
        BOOL passed = [[NSSet setWithArray:required] isSubsetOfSet:self.seen] && ![self.seen containsObject:@"UNTRUSTED"];
        NSString *signature = [FaceclawCrypto hmacSha256:@"key" message:@"The quick brown fox jumps over the lazy dog"];
        passed &= [signature isEqual:@"97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg="];
        self.foregroundPassed = passed;
        void (^handler)(NSString *) = self.host.eventHandler;
        [self.host showOnPhone]; [self.host hideOnPhone]; [self.host destroy];
        self.phase = 6; self.host = [FaceclawEvenHubWebView new];
        self.host.eventHandler = handler;
        [self.host start:[root stringByAppendingPathComponent:@"dist"] entrypoint:@"index.html" script:script];
    });
    return YES;
}
- (void)applicationDidEnterBackground:(UIApplication *)app {
    if (self.phase != 6) return;
    // Give the isolated probe a brief execution window without requiring BLE.
    // Production relies on Faceclaw's existing background execution support.
    self.backgroundTask = [app beginBackgroundTaskWithName:@"EvenHub timer regression" expirationHandler:^{
        [app endBackgroundTask:self.backgroundTask]; self.backgroundTask = UIBackgroundTaskInvalid;
    }];
    [self.host evaluate:@"flutter_inappwebview.callHandler('input');"
        "setTimeout(function(){flutter_inappwebview.callHandler('timeout')},100);"
        "var count=0; var interval=setInterval(function(){flutter_inappwebview.callHandler('interval');if(++count===3)clearInterval(interval)},100);"
        "requestAnimationFrame(function(){flutter_inappwebview.callHandler('animation')});"
        "var cancelled=setTimeout(function(){flutter_inappwebview.callHandler('CANCELLED')},100);clearTimeout(cancelled);"];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSArray *required = @[@"background:input", @"background:timeout", @"background:interval", @"background:animation"];
        BOOL passed = self.foregroundPassed && app.applicationState == UIApplicationStateBackground &&
            [[NSSet setWithArray:required] isSubsetOfSet:self.seen] && self.backgroundIntervals == 3 &&
            ![self.seen containsObject:@"CANCELLED"];
        [self.host destroy];
        NSDictionary *result = @{@"passed": @(passed), @"seen": self.seen.allObjects,
            @"backgroundIntervals": @(self.backgroundIntervals)};
        [self writeResult:result name:@"result.json"];
        NSLog(@"EHPROBE RESULT %@", result);
        if (self.backgroundTask != UIBackgroundTaskInvalid) {
            [app endBackgroundTask:self.backgroundTask]; self.backgroundTask = UIBackgroundTaskInvalid;
        }
    });
}
@end
int main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(Probe.class)); } }
