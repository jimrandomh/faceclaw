#import "FaceclawWebSignIn.h"
#import "FaceclawLoopbackRedirect.h"
#import <AuthenticationServices/AuthenticationServices.h>
#import <UIKit/UIKit.h>

/** Never reached: the loopback receiver ends the session before any custom-scheme redirect. */
static NSString *const kUnusedCallbackScheme = @"faceclaw-signin";

@interface FaceclawWebSignIn () <ASWebAuthenticationPresentationContextProviding>
@property(nonatomic, strong) FaceclawLoopbackRedirect *receiver;
@property(nonatomic, strong) ASWebAuthenticationSession *session;
@property(nonatomic, copy) void (^completion)(NSString *redirectUrl, NSString *error);
/** The sign-in page waiting for Faceclaw to come to the foreground. */
@property(nonatomic, copy) NSURL *pendingUrl;
@property(nonatomic, strong) id activeObserver;
@end

@implementation FaceclawWebSignIn
+ (instancetype)shared {
    static FaceclawWebSignIn *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [FaceclawWebSignIn new]; });
    return instance;
}

- (void)signIn:(NSString *)authorizeUrl port:(NSInteger)port path:(NSString *)path
    completion:(void (^)(NSString *, NSString *))completion {
    [self finishWithUrl:nil error:@"cancelled"];
    NSURL *url = [NSURL URLWithString:authorizeUrl];
    if (!url || ![url.scheme isEqualToString:@"https"]) {
        if (completion) completion(nil, @"Invalid sign-in address");
        return;
    }
    FaceclawLoopbackRedirect *receiver = [FaceclawLoopbackRedirect new];
    NSString *error = [receiver startOnPort:port path:path];
    if (error) {
        if (completion) completion(nil, error);
        return;
    }
    __weak typeof(self) weakSelf = self;
    receiver.redirectHandler = ^(NSString *redirectUrl) {
        [weakSelf finishWithUrl:redirectUrl error:nil];
    };
    self.receiver = receiver;
    self.completion = completion;
    if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive) {
        [self present:url];
        return;
    }
    self.pendingUrl = url;
    self.activeObserver = [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
        object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            FaceclawWebSignIn *strongSelf = weakSelf;
            NSURL *pending = strongSelf.pendingUrl;
            if (!pending) return;
            [strongSelf removeActiveObserver];
            [strongSelf present:pending];
        }];
}

- (void)cancel {
    [self finishWithUrl:nil error:@"cancelled"];
}

- (void)present:(NSURL *)url {
    __weak typeof(self) weakSelf = self;
    ASWebAuthenticationSession *session = [[ASWebAuthenticationSession alloc] initWithURL:url
        callbackURLScheme:kUnusedCallbackScheme completionHandler:^(NSURL *callbackURL, NSError *error) {
            // The sheet closed: the user dismissed it, or finishing already cancelled it.
            BOOL dismissed = !error || ([error.domain isEqualToString:ASWebAuthenticationSessionErrorDomain]
                && error.code == ASWebAuthenticationSessionErrorCodeCanceledLogin);
            [weakSelf finishWithUrl:callbackURL.absoluteString
                error:callbackURL ? nil : dismissed ? @"cancelled" : error.localizedDescription];
        }];
    session.presentationContextProvider = self;
    session.prefersEphemeralWebBrowserSession = NO;
    self.session = session;
    if (![session start]) [self finishWithUrl:nil error:@"Could not open the sign-in page"];
}

/** Report the outcome once; tear down the receiver and close the sheet. */
- (void)finishWithUrl:(NSString *)url error:(NSString *)error {
    void (^completion)(NSString *, NSString *) = self.completion;
    ASWebAuthenticationSession *session = self.session;
    self.completion = nil;
    self.session = nil;
    self.pendingUrl = nil;
    [self removeActiveObserver];
    [self.receiver stop];
    self.receiver = nil;
    // Re-enters through the session's completion handler, which then finds nothing to report.
    [session cancel];
    if (completion) completion(url, url ? nil : error);
}

- (void)removeActiveObserver {
    if (self.activeObserver) [NSNotificationCenter.defaultCenter removeObserver:self.activeObserver];
    self.activeObserver = nil;
}

- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        NSArray<UIWindow *> *windows = ((UIWindowScene *)scene).windows;
        for (UIWindow *window in windows) if (window.isKeyWindow) return window;
        if (windows.firstObject) return windows.firstObject;
    }
    return [UIWindow new];
}
@end
