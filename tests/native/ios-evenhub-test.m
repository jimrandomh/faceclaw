#import <UIKit/UIKit.h>
#import "FaceclawEvenHubWebView.h"

@interface Probe : UIResponder <UIApplicationDelegate>
@property(nonatomic) UIWindow *window;
@property(nonatomic) FaceclawEvenHubWebView *host;
@property(nonatomic) NSMutableSet *seen;
@property(nonatomic) NSInteger phase;
@end
@implementation Probe
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
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
        if ([event[@"kind"] isEqual:@"call"]) {
            [weakSelf.seen addObject:event[@"name"]];
            [weakSelf.seen addObject:[NSString stringWithFormat:@"%ld:%@", (long)weakSelf.phase, event[@"name"]]];
            [weakSelf.host evaluate:[NSString stringWithFormat:@"window.__fcResolve(%@,true,true)", event[@"id"]]];
        }
    };
    NSString *root = NSBundle.mainBundle.resourcePath;
    NSString *script = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"bridge.js"] encoding:NSUTF8StringEncoding error:nil];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.host start:[root stringByAppendingPathComponent:@"dist"] entrypoint:@"index.html" script:script];
    });
    for (NSInteger phase = 2; phase <= 3; phase++) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (phase - 1) * 4 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            void (^handler)(NSString *) = self.host.eventHandler;
            [self.host showOnPhone]; [self.host hideOnPhone]; [self.host destroy];
            self.phase = phase; self.host = [FaceclawEvenHubWebView new];
            self.host.eventHandler = handler;
            self.host.packageIdentifier = phase == 2 ? package : [package stringByAppendingString:@".other"];
            [self.host start:[root stringByAppendingPathComponent:@"dist"] entrypoint:@"index.html" script:script];
        });
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSArray *required = @[@"early", @"module", @"fetch", @"image", @"timer", @"raf", @"wasm", @"traversal", @"1:stored", @"2:restored", @"3:stored"];
        BOOL passed = [[NSSet setWithArray:required] isSubsetOfSet:self.seen];
        [self.host showOnPhone]; [self.host hideOnPhone]; [self.host destroy];
        NSDictionary *result = @{@"passed": @(passed), @"seen": self.seen.allObjects};
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *documents = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
        [data writeToFile:[documents stringByAppendingPathComponent:@"result.json"] atomically:YES];
        NSLog(@"EHPROBE RESULT %@", result);
    });
    return YES;
}
@end
int main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(Probe.class)); } }
