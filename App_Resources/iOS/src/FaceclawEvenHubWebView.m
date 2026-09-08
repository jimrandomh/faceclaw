#import "FaceclawEvenHubWebView.h"
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <CommonCrypto/CommonDigest.h>

@interface FaceclawEvenHubWebView ()
@property(nonatomic) WKWebView *webView;
@property(nonatomic) UIView *host;
@property(nonatomic) UIButton *back;
@property(nonatomic) NSTimer *timer;
@property(nonatomic) NSString *directory;
@property(nonatomic) BOOL ticking;
@property(nonatomic) BOOL destroyed;
@end

@implementation FaceclawEvenHubWebView
- (void)emit:(NSDictionary *)event {
    if (!_eventHandler || _destroyed) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (data) _eventHandler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
- (void)start:(NSString *)directory entrypoint:(NSString *)entrypoint script:(NSString *)script {
    _directory = directory.stringByStandardizingPath.stringByResolvingSymlinksInPath;
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    // Isolate browser storage by package, retaining it across closing/reopening.
    // SDK storage also persists independently through the shared TS session.
    config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    if (@available(iOS 17.0, *)) {
        if (_packageIdentifier.length) {
            NSData *key = [[@"com.faceclaw.ehpk:" stringByAppendingString:_packageIdentifier] dataUsingEncoding:NSUTF8StringEncoding];
            unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(key.bytes, (CC_LONG)key.length, digest);
            config.websiteDataStore = [WKWebsiteDataStore dataStoreForIdentifier:[[NSUUID alloc] initWithUUIDBytes:digest]];
        }
    }
    [config setURLSchemeHandler:self forURLScheme:@"faceclaw-ehpk"];
    [config.userContentController addScriptMessageHandler:self name:@"faceclaw"];
    [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:script
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    _webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    _webView.navigationDelegate = self;
    _webView.accessibilityIdentifier = @"evenhub-webview";
    UIWindow *window = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *candidate in ((UIWindowScene *)scene).windows) if (candidate.isKeyWindow) window = candidate;
    }
    if (!window) window = UIApplication.sharedApplication.keyWindow;
    if (!window) { [self emit:@{@"kind": @"error", @"message": @"No phone window is available."}]; return; }
    _host = [[UIView alloc] initWithFrame:window.bounds];
    _host.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _host.backgroundColor = UIColor.systemBackgroundColor;
    _host.userInteractionEnabled = NO;
    _host.accessibilityElementsHidden = YES;
    [window insertSubview:_host atIndex:0];
    [_host addSubview:_webView];
    _webView.translatesAutoresizingMaskIntoConstraints = NO;
    _back = [UIButton buttonWithType:UIButtonTypeSystem];
    [_back setTitle:@"Back to Faceclaw" forState:UIControlStateNormal];
    _back.accessibilityIdentifier = @"evenhub-back";
    [_back addTarget:self action:@selector(hideOnPhone) forControlEvents:UIControlEventTouchUpInside];
    [_host addSubview:_back]; _back.translatesAutoresizingMaskIntoConstraints = NO;
    [NSLayoutConstraint activateConstraints:@[
        [_back.topAnchor constraintEqualToAnchor:_host.safeAreaLayoutGuide.topAnchor],
        [_back.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [_back.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [_back.heightAnchor constraintEqualToConstant:44],
        [_webView.topAnchor constraintEqualToAnchor:_back.bottomAnchor],
        [_webView.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [_webView.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [_webView.bottomAnchor constraintEqualToAnchor:_host.safeAreaLayoutGuide.bottomAnchor]
    ]];
    // Keep a nonzero attached view behind the dashboard; do not hide/detach it.
    // Bound host ticks to one evaluation in flight, including across suspension.
    __weak typeof(self) weakSelf = self;
    _timer = [NSTimer timerWithTimeInterval:1.0 / 60 repeats:YES block:^(NSTimer *timer) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf || strongSelf.ticking || UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
        strongSelf.ticking = YES;
        [strongSelf.webView evaluateJavaScript:@"window.__fcTimerTick && window.__fcTimerTick(); window.__fcRafTick && window.__fcRafTick();" completionHandler:^(id result, NSError *error) {
            weakSelf.ticking = NO;
        }];
    }];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
    NSURLComponents *url = [NSURLComponents new];
    url.scheme = @"faceclaw-ehpk"; url.host = @"app"; url.path = [@"/" stringByAppendingString:entrypoint];
    [_webView loadRequest:[NSURLRequest requestWithURL:url.URL]];
}
- (void)evaluate:(NSString *)script {
    if (!_destroyed) [_webView evaluateJavaScript:script completionHandler:nil];
}
- (void)showOnPhone {
    if (_destroyed) return;
    [_host.superview bringSubviewToFront:_host]; _host.userInteractionEnabled = YES; _host.accessibilityElementsHidden = NO;
}
- (void)hideOnPhone {
    [_host endEditing:YES]; [_host.superview sendSubviewToBack:_host]; _host.userInteractionEnabled = NO; _host.accessibilityElementsHidden = YES;
    [self emit:@{@"kind": @"hidden"}];
}
- (void)destroy {
    if (_destroyed) return;
    _destroyed = YES; [_timer invalidate]; _timer = nil;
    [_webView stopLoading]; _webView.navigationDelegate = nil;
    [_webView.configuration.userContentController removeScriptMessageHandlerForName:@"faceclaw"];
    [_webView.configuration.userContentController removeAllUserScripts];
    [_host removeFromSuperview]; _host = nil; _back = nil; _webView = nil; _eventHandler = nil;
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // Subframes and navigated third-party documents never receive host access.
    NSURL *url = message.frameInfo.request.URL;
    if (!message.frameInfo.isMainFrame || ![url.scheme isEqual:@"faceclaw-ehpk"] || ![url.host isEqual:@"app"]) return;
    if ([message.body isKindOfClass:NSDictionary.class]) [self emit:message.body];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    BOOL local = [url.scheme isEqual:@"faceclaw-ehpk"] && [url.host isEqual:@"app"];
    decisionHandler(local && action.targetFrame.isMainFrame ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    [self emit:@{@"kind": @"loaded"}];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self emit:@{@"kind": @"error", @"message": error.localizedDescription}];
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self emit:@{@"kind": @"error", @"message": error.localizedDescription}];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [self emit:@{@"kind": @"error", @"message": @"The app's web process ended. Close and reopen the app."}];
}
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *relative = [url.path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]];
    NSString *file = [[_directory stringByAppendingPathComponent:relative] stringByStandardizingPath].stringByResolvingSymlinksInPath;
    BOOL allowed = !_destroyed && [url.host isEqual:@"app"] &&
        [file hasPrefix:[_directory stringByAppendingString:@"/"]];
    NSData *data = allowed ? [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil] : nil;
    NSString *ext = file.pathExtension.lowercaseString;
    NSString *mime = [@{@"js": @"text/javascript", @"mjs": @"text/javascript", @"html": @"text/html",
        @"css": @"text/css", @"json": @"application/json", @"wasm": @"application/wasm", @"svg": @"image/svg+xml"} objectForKey:ext];
    if (!mime) mime = [UTType typeWithFilenameExtension:ext].preferredMIMEType ?: @"application/octet-stream";
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:data ? 200 : 404
        HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type": mime, @"Access-Control-Allow-Origin": @"*", @"Cache-Control": @"no-store"}];
    // Synchronous completion on WebKit's main-queue callback means there is no
    // outstanding task to finish after stopURLSchemeTask cancels it.
    [task didReceiveResponse:response]; [task didReceiveData:data ?: NSData.data]; [task didFinish];
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end
