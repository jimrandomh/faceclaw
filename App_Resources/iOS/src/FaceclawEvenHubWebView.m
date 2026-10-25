#import "FaceclawEvenHubWebView.h"
#import <UIKit/UIKit.h>
#import <SafariServices/SafariServices.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <CommonCrypto/CommonDigest.h>

@interface FaceclawEvenHubWebView ()
@property(nonatomic) WKWebView *webView;
@property(nonatomic) UIView *host;
@property(nonatomic) UIButton *back;
@property(nonatomic) UIButton *returnButton;
@property(nonatomic) NSTimer *timer;
@property(nonatomic) NSString *directory;
@property(nonatomic) NSString *script;
/** The app's start page. Only documents from its origin get the bridge. */
@property(nonatomic) NSURL *startURL;
/** The redirect_uri of a sign-in the app started; the provider's reply is finished inside the app. */
@property(nonatomic) NSURL *returnURL;
/** The main frame shows a page outside the app's origin (a sign-in page, a followed link). */
@property(nonatomic) BOOL away;
@property(nonatomic) BOOL committed;
@property(nonatomic) BOOL ticking;
@property(nonatomic) BOOL destroyed;
@end

static NSInteger FCDefaultPort(NSString *scheme) {
    scheme = scheme.lowercaseString;
    return [scheme isEqual:@"https"] ? 443 : [scheme isEqual:@"http"] ? 80 : 0;
}
static BOOL FCIsWebURL(NSURL *url) {
    NSString *scheme = url.scheme.lowercaseString;
    return [scheme isEqual:@"http"] || [scheme isEqual:@"https"];
}
static BOOL FCSameOrigin(NSURL *origin, NSString *scheme, NSString *host, NSInteger port) {
    return origin && host.length && [scheme.lowercaseString isEqual:origin.scheme.lowercaseString] &&
        [host.lowercaseString isEqual:origin.host.lowercaseString] &&
        (port ?: FCDefaultPort(scheme)) == (origin.port.integerValue ?: FCDefaultPort(origin.scheme));
}
/** A newer navigation replaced this one, or the policy below cancelled it; the current page is unaffected. */
static BOOL FCIsInterruption(NSError *error) {
    return ([error.domain isEqual:NSURLErrorDomain] && error.code == NSURLErrorCancelled) ||
        ([error.domain isEqual:@"WebKitErrorDomain"] && error.code == 102); // FrameLoadInterruptedByPolicyChange
}

@implementation FaceclawEvenHubWebView
- (void)emit:(NSDictionary *)event {
    if (!_eventHandler || _destroyed) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (data) _eventHandler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
- (void)notice:(NSString *)message {
    [self emit:@{@"kind": @"notice", @"message": message.length > 4000 ? [message substringToIndex:4000] : message}];
}
- (void)start:(NSString *)directory entrypoint:(NSString *)entrypoint script:(NSString *)script {
    _directory = directory.stringByStandardizingPath.stringByResolvingSymlinksInPath;
    NSURLComponents *url = [NSURLComponents new];
    url.scheme = @"faceclaw-ehpk"; url.host = @"app"; url.path = [@"/" stringByAppendingString:entrypoint];
    [self startRequest:url.URL script:script];
}
- (void)startURL:(NSString *)url script:(NSString *)script {
    NSURL *target = [NSURL URLWithString:url];
    if (!target.host.length || !FCIsWebURL(target) || target.user || target.password) {
        [self emit:@{@"kind": @"error", @"message": @"Invalid app URL."}]; return;
    }
    [self startRequest:target script:script];
}
- (void)startRequest:(NSURL *)url script:(NSString *)script {
    if (_destroyed) return;
    _startURL = url; _script = script;
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
    [self installScript:config.userContentController];
    _webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    _webView.navigationDelegate = self; _webView.UIDelegate = self;
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
    // Shown only while the page is outside the app, e.g. an abandoned sign-in.
    _returnButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [_returnButton setTitle:@"Return to app" forState:UIControlStateNormal];
    _returnButton.accessibilityIdentifier = @"evenhub-return";
    _returnButton.hidden = YES;
    [_returnButton addTarget:self action:@selector(returnToApp) forControlEvents:UIControlEventTouchUpInside];
    UIStackView *bar = [[UIStackView alloc] initWithArrangedSubviews:@[_back, _returnButton]];
    bar.distribution = UIStackViewDistributionFillEqually;
    [_host addSubview:bar]; bar.translatesAutoresizingMaskIntoConstraints = NO;
    [NSLayoutConstraint activateConstraints:@[
        [bar.topAnchor constraintEqualToAnchor:_host.safeAreaLayoutGuide.topAnchor],
        [bar.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [bar.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [bar.heightAnchor constraintEqualToConstant:44],
        [_webView.topAnchor constraintEqualToAnchor:bar.bottomAnchor],
        [_webView.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [_webView.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [_webView.bottomAnchor constraintEqualToAnchor:_host.safeAreaLayoutGuide.bottomAnchor]
    ]];
    // Keep a nonzero attached view behind the dashboard; do not hide/detach it.
    // Tick whenever iOS gives us execution time, including in the background or
    // with the phone locked. Gating on UIApplicationStateActive stalls the
    // injected timers/rAF even while BLE input can still evaluate JavaScript.
    // Bound host ticks to one evaluation in flight, including across suspension.
    __weak typeof(self) weakSelf = self;
    _timer = [NSTimer timerWithTimeInterval:1.0 / 60 repeats:YES block:^(NSTimer *timer) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf || strongSelf.destroyed || strongSelf.ticking || strongSelf.away) return;
        strongSelf.ticking = YES;
        [strongSelf.webView evaluateJavaScript:@"window.__fcTimerTick && window.__fcTimerTick(); window.__fcRafTick && window.__fcRafTick();" completionHandler:^(id result, NSError *error) {
            weakSelf.ticking = NO;
        }];
    }];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
    [_webView loadRequest:[NSURLRequest requestWithURL:url]];
}
/** The bridge scripts run only in the app's own documents, never in pages it navigates to. */
- (void)installScript:(WKUserContentController *)controller {
    NSData *start = [NSJSONSerialization dataWithJSONObject:_startURL.absoluteString options:NSJSONWritingFragmentsAllowed error:nil];
    NSString *source = [NSString stringWithFormat:@"if ((function (app) { return app.protocol === location.protocol && app.host === location.host; })(new URL(%@))) {\n%@\n}",
        [[NSString alloc] initWithData:start encoding:NSUTF8StringEncoding], _script];
    [controller removeAllUserScripts];
    [controller addUserScript:[[WKUserScript alloc] initWithSource:source
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
}
- (void)evaluate:(NSString *)script {
    // Host messages are for the app's documents; a page it navigated to must not receive them.
    if (!_destroyed && !_away) [_webView evaluateJavaScript:script completionHandler:nil];
}
- (void)showOnPhone {
    if (_destroyed) return;
    [_host.superview bringSubviewToFront:_host]; _host.userInteractionEnabled = YES; _host.accessibilityElementsHidden = NO;
}
- (void)hideOnPhone {
    [_host endEditing:YES]; [_host.superview sendSubviewToBack:_host]; _host.userInteractionEnabled = NO; _host.accessibilityElementsHidden = YES;
    [self emit:@{@"kind": @"hidden"}];
}
- (void)returnToApp {
    if (_destroyed) return;
    _returnURL = nil; [_webView loadRequest:[NSURLRequest requestWithURL:_startURL]];
}
- (void)destroy {
    if (_destroyed) return;
    _destroyed = YES; [_timer invalidate]; _timer = nil;
    [_webView stopLoading]; _webView.navigationDelegate = nil; _webView.UIDelegate = nil;
    [_webView.configuration.userContentController removeScriptMessageHandlerForName:@"faceclaw"];
    [_webView.configuration.userContentController removeAllUserScripts];
    [_host removeFromSuperview]; _host = nil; _back = nil; _returnButton = nil; _webView = nil; _eventHandler = nil;
}
- (BOOL)isAppURL:(NSURL *)url {
    return FCSameOrigin(_startURL, url.scheme, url.host, url.port.integerValue);
}
- (BOOL)isAppFrame:(WKFrameInfo *)frame {
    WKSecurityOrigin *origin = frame.securityOrigin;
    return frame.isMainFrame && FCSameOrigin(_startURL, origin.protocol, origin.host, origin.port);
}
/** An OAuth authorization request names where the provider replies. */
- (void)rememberReturnURLFrom:(NSURL *)url {
    for (NSURLQueryItem *item in [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO].queryItems) {
        NSURL *target = [item.name isEqual:@"redirect_uri"] && item.value ? [NSURL URLWithString:item.value] : nil;
        // A redirect_uri on the app's own origin needs no help: the app handles it itself.
        if (FCIsWebURL(target) && target.host.length && ![self isAppURL:target]) _returnURL = target;
    }
}
- (BOOL)isReturnURL:(NSURL *)url {
    // NSURL.path drops a trailing slash, so ".../callback/" and ".../callback" match.
    NSString *path = url.path.length ? url.path : @"/", *returnPath = _returnURL.path.length ? _returnURL.path : @"/";
    return FCSameOrigin(_returnURL, url.scheme, url.host, url.port.integerValue) && [path isEqual:returnPath];
}
/** The app's start page carrying the provider's reply (its query and fragment). */
- (void)loadAppWithResultOf:(NSURL *)url {
    NSURLComponents *result = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    NSURLComponents *app = [NSURLComponents componentsWithURL:_startURL resolvingAgainstBaseURL:NO];
    if (result.percentEncodedQuery.length) app.percentEncodedQuery = app.percentEncodedQuery.length ?
        [NSString stringWithFormat:@"%@&%@", app.percentEncodedQuery, result.percentEncodedQuery] : result.percentEncodedQuery;
    if (result.percentEncodedFragment) app.percentEncodedFragment = result.percentEncodedFragment;
    NSURL *target = app.URL;
    _returnURL = nil;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.destroyed) [self.webView loadRequest:[NSURLRequest requestWithURL:target]];
    });
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // Only the app's own main frame gets host access: not subframes, nor pages the app navigated to.
    if (![self isAppFrame:message.frameInfo]) return;
    if ([message.body isKindOfClass:NSDictionary.class]) [self emit:message.body];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    NSString *scheme = url.scheme.lowercaseString;
    // A new window (target=_blank, window.open): createWebView below opens it outside the app.
    if (!action.targetFrame) { decisionHandler(WKNavigationActionPolicyAllow); return; }
    // Subframes load as in a browser; they never get the bridge.
    if (!action.targetFrame.isMainFrame) {
        BOOL allowed = FCIsWebURL(url) || [self isAppURL:url] || [@[@"about", @"data", @"blob"] containsObject:scheme];
        decisionHandler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel); return;
    }
    if ([self isAppURL:url]) { _returnURL = nil; decisionHandler(WKNavigationActionPolicyAllow); return; }
    if (FCIsWebURL(url) && !_committed && !_directory.length) {
        // The app URL redirected before anything loaded: the app lives where it lands. The
        // script update reaches the web process ahead of the policy reply.
        _startURL = url; [self installScript:webView.configuration.userContentController];
        decisionHandler(WKNavigationActionPolicyAllow); return;
    }
    if (_returnURL && [self isReturnURL:url]) {
        // A sign-in provider replying: finish in the app rather than at the page the redirect_uri names.
        decisionHandler(WKNavigationActionPolicyCancel); [self loadAppWithResultOf:url]; return;
    }
    if (!FCIsWebURL(url)) {
        [self notice:[NSString stringWithFormat:@"Blocked navigation to a %@: URL.", scheme ?: @"schemeless"]];
        decisionHandler(WKNavigationActionPolicyCancel); return;
    }
    // Leaving the app's origin. Such pages never get the bridge; "Return to app" leads back.
    if ([self isAppFrame:action.sourceFrame]) [self rememberReturnURLFrom:url];
    decisionHandler(WKNavigationActionPolicyAllow);
}
- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    _committed = YES; _away = ![self isAppURL:webView.URL]; _returnButton.hidden = !_away;
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (!_away) [self emit:@{@"kind": @"loaded"}];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (!FCIsInterruption(error)) [self emit:@{@"kind": @"error", @"message": error.localizedDescription}];
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (!FCIsInterruption(error)) [self emit:@{@"kind": @"error", @"message": error.localizedDescription}];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [self emit:@{@"kind": @"error", @"fatal": @YES, @"message": @"The app's web process ended. Close and reopen the app."}];
}
/** What to present over, only while the app's phone UI is shown and not mid-transition. */
- (UIViewController *)presenter {
    if (_destroyed || !_host.userInteractionEnabled) return nil;
    UIViewController *controller = _host.window.rootViewController;
    while (controller.presentedViewController) controller = controller.presentedViewController;
    return controller.transitionCoordinator ? nil : controller;
}
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSURL *url = action.request.URL;
    UIViewController *presenter = FCIsWebURL(url) ? [self presenter] : nil;
    if (presenter) [presenter presentViewController:[[SFSafariViewController alloc] initWithURL:url] animated:YES completion:nil];
    else [self notice:[NSString stringWithFormat:@"Did not open a window for a %@: URL.", url.scheme ?: @"schemeless"]];
    return nil;
}
// JavaScript dialogs. WebKit requires each completion handler to run exactly once, so a
// dialog that cannot be shown (the app is hidden) completes at once with its default.
- (UIAlertController *)dialog:(NSString *)message {
    if ([self presenter]) return [UIAlertController alertControllerWithTitle:nil message:message preferredStyle:UIAlertControllerStyleAlert];
    [self notice:[@"Dialog while hidden: " stringByAppendingString:message ?: @""]];
    return nil;
}
- (BOOL)presentDialog:(UIAlertController *)alert {
    if (!alert) return NO;
    [[self presenter] presentViewController:alert animated:YES completion:nil];
    return alert.presentingViewController != nil;
}
- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    UIAlertController *alert = [self dialog:message];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) { completionHandler(); }]];
    if (![self presentDialog:alert]) completionHandler();
}
- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    UIAlertController *alert = [self dialog:message];
    [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *action) { completionHandler(NO); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) { completionHandler(YES); }]];
    if (![self presentDialog:alert]) completionHandler(NO);
}
- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))completionHandler {
    UIAlertController *alert = [self dialog:prompt];
    [alert addTextFieldWithConfigurationHandler:^(UITextField *field) { field.text = defaultText; }];
    __weak UIAlertController *weakAlert = alert;
    [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *action) { completionHandler(nil); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
        completionHandler(weakAlert.textFields.firstObject.text ?: @"");
    }]];
    if (![self presentDialog:alert]) completionHandler(nil);
}
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *relative = [url.path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]];
    NSString *file = [[_directory stringByAppendingPathComponent:relative] stringByStandardizingPath].stringByResolvingSymlinksInPath;
    BOOL allowed = !_destroyed && _directory.length && [url.host isEqual:@"app"] &&
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
