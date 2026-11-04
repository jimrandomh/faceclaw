#import "FaceclawWatchBridge.h"
#import <UIKit/UIKit.h>
#import <WatchConnectivity/WatchConnectivity.h>

// Live messages are {path, json, ...}; the watch app's Protocol.swift mirrors these keys.
static NSString *const kKeyPath = @"path";
static NSString *const kKeyJson = @"json";
static NSString *const kKeyUpdatedAt = @"updatedAt";
static NSString *const kKeyEvent = @"event";
static NSString *const kKeyEventAt = @"eventAt";
static NSString *const kKeyAt = @"at";
static NSString *const kKeyBattery = @"battery";

static NSString *const kPathState = @"/faceclaw/state";
static NSString *const kPathStateRequest = @"/faceclaw/state/request";
static NSString *const kPathBattery = @"/faceclaw/battery";
static NSString *const kPathPress = @"/faceclaw/press";
static NSString *const kPathAck = @"/faceclaw/ack";
static NSString *const kPathEvent = @"/faceclaw/event";

/** State requests kept for a JS handler that isn't registered yet. */
static const NSUInteger kPendingLimit = 16;
static const NSTimeInterval kPendingMaxAge = 30;

static long long NowMs(void) {
    return (long long)(NSDate.date.timeIntervalSince1970 * 1000);
}

static double ReadSeq(NSString *json) {
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    id seq = [parsed isKindOfClass:NSDictionary.class] ? parsed[@"seq"] : nil;
    return [seq isKindOfClass:NSNumber.class] ? [seq doubleValue] : 0;
}

@interface FaceclawWatchPendingMessage : NSObject
@property(nonatomic, copy) NSString *path;
@property(nonatomic, copy) NSString *json;
@property(nonatomic, strong) NSDate *receivedAt;
@end
@implementation FaceclawWatchPendingMessage
@end

@interface FaceclawWatchBridge () <WCSessionDelegate>
@property(nonatomic, copy, nullable) void (^messageHandler)(NSString *, NSString *);
@property(nonatomic, copy, nullable) void (^connectionHandler)(void);
@property(nonatomic, strong) NSMutableArray<FaceclawWatchPendingMessage *> *pending;
@property(nonatomic, copy, nullable) NSString *lastState;
@property(nonatomic) long long lastStateAt;
@property(nonatomic, copy, nullable) NSString *heldEvent;
@property(nonatomic) long long heldEventAt;
/** Sends and context updates run here: they cost IPC, and the main thread also runs BLE. */
@property(nonatomic, strong) dispatch_queue_t sendQueue;
/** Latest context waiting for sendQueue; nil when none is queued. Guarded by @synchronized(self). */
@property(nonatomic, copy, nullable) NSDictionary *queuedContext;
@end

@implementation FaceclawWatchBridge

+ (void)load {
    // Registering here is what puts the delegate in place during launch, ahead of JS.
    [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidFinishLaunchingNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *note) {
        [[FaceclawWatchBridge shared] activate];
    }];
}

+ (instancetype)shared {
    static FaceclawWatchBridge *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [FaceclawWatchBridge new]; });
    return instance;
}

- (instancetype)init {
    if ((self = [super init])) {
        _pending = [NSMutableArray new];
        _sendQueue = dispatch_queue_create("com.faceclaw.watch.send", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)activate {
    if (!WCSession.isSupported) return;
    WCSession *session = WCSession.defaultSession;
    if (session.delegate == self) return;
    session.delegate = self;
    [session activateSession];
}

#pragma mark - Public API (main thread)

- (BOOL)isAvailable {
    return WCSession.isSupported;
}

- (BOOL)isWatchAppAvailable {
    if (!WCSession.isSupported) return NO;
    WCSession *session = WCSession.defaultSession;
    if (session.activationState != WCSessionActivationStateActivated) return NO;
    return session.isReachable || (session.isPaired && session.isWatchAppInstalled);
}

- (void)setMessageHandler:(void (^)(NSString *, NSString *))messageHandler
        connectionHandler:(void (^)(void))connectionHandler {
    self.messageHandler = messageHandler;
    self.connectionHandler = connectionHandler;
    [self activate];
    NSArray<FaceclawWatchPendingMessage *> *replay = [self.pending copy];
    [self.pending removeAllObjects];
    for (FaceclawWatchPendingMessage *message in replay) {
        if (-message.receivedAt.timeIntervalSinceNow <= kPendingMaxAge) messageHandler(message.path, message.json);
    }
    // The watch's last battery report may have arrived while no one was listening.
    if (WCSession.isSupported && WCSession.defaultSession.activationState == WCSessionActivationStateActivated) {
        [self deliverBatteryFrom:WCSession.defaultSession.receivedApplicationContext];
    }
}

- (void)publishState:(NSString *)json force:(BOOL)force {
    if (!force && [json isEqualToString:self.lastState]) return;
    self.lastState = json;
    self.lastStateAt = NowMs();
    [self pushContext];
    [self sendLive:@{kKeyPath: kPathState, kKeyJson: json, kKeyUpdatedAt: @(self.lastStateAt)}];
}

- (void)sendEvent:(NSString *)json sticky:(BOOL)sticky {
    long long at = NowMs();
    if (sticky) {
        self.heldEvent = json;
        self.heldEventAt = at;
        [self pushContext];
    }
    [self sendLive:@{kKeyPath: kPathEvent, kKeyJson: json, kKeyAt: @(at)}];
}

- (void)sendToWatch:(NSString *)path json:(NSString *)json {
    [self sendLive:@{kKeyPath: path, kKeyJson: json}];
}

- (void)sendAck:(double)seq ok:(BOOL)ok jsReady:(BOOL)jsReady message:(NSString *)message {
    NSDictionary *ack = @{@"seq": @(seq), @"ok": @(ok), @"jsReady": @(jsReady), @"message": message ?: @""};
    NSData *data = [NSJSONSerialization dataWithJSONObject:ack options:0 error:nil];
    if (!data) return;
    [self sendToWatch:kPathAck json:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]];
}

#pragma mark - Sending

- (void)sendLive:(NSDictionary *)message {
    if (!WCSession.isSupported) return;
    dispatch_async(self.sendQueue, ^{
        WCSession *session = WCSession.defaultSession;
        if (session.activationState != WCSessionActivationStateActivated || !session.isReachable) return;
        [session sendMessage:message replyHandler:nil errorHandler:^(NSError *error) {
            NSLog(@"[FaceclawWatch] send %@ failed: %@", message[kKeyPath], error);
        }];
    });
}

/** Queue the current state and held event as the application context; only the latest matters. */
- (void)pushContext {
    if (!WCSession.isSupported) return;
    NSMutableDictionary *context = [NSMutableDictionary new];
    if (self.lastState) {
        context[kKeyJson] = self.lastState;
        context[kKeyUpdatedAt] = @(self.lastStateAt);
    }
    if (self.heldEvent) {
        context[kKeyEvent] = self.heldEvent;
        context[kKeyEventAt] = @(self.heldEventAt);
    }
    BOOL alreadyQueued;
    @synchronized (self) {
        alreadyQueued = self.queuedContext != nil;
        self.queuedContext = context;
    }
    if (alreadyQueued) return;
    dispatch_async(self.sendQueue, ^{
        NSDictionary *next;
        @synchronized (self) {
            next = self.queuedContext;
            self.queuedContext = nil;
        }
        WCSession *session = WCSession.defaultSession;
        if (!next || session.activationState != WCSessionActivationStateActivated) return;
        if (!session.isPaired || !session.isWatchAppInstalled) return;
        NSError *error = nil;
        if (![session updateApplicationContext:next error:&error]) {
            NSLog(@"[FaceclawWatch] application context update failed: %@", error);
        }
    });
}

#pragma mark - Receiving

- (void)handleMessage:(NSString *)path json:(NSString *)json {
    if (self.messageHandler) {
        self.messageHandler(path, json);
        return;
    }
    // A battery report is status and a touch-down only matters live; neither expects an ack.
    if ([path isEqualToString:kPathBattery] || [path isEqualToString:kPathPress]) return;
    // Gestures and commands are refused rather than replayed: the watch reports them as failed,
    // and running them later would act on whatever the glasses happen to show by then.
    if ([path isEqualToString:kPathStateRequest]) {
        NSDate *now = NSDate.date;
        while (self.pending.count > 0 && [now timeIntervalSinceDate:self.pending.firstObject.receivedAt] > kPendingMaxAge) {
            [self.pending removeObjectAtIndex:0];
        }
        if (self.pending.count >= kPendingLimit) [self.pending removeObjectAtIndex:0];
        FaceclawWatchPendingMessage *message = [FaceclawWatchPendingMessage new];
        message.path = path;
        message.json = json;
        message.receivedAt = now;
        [self.pending addObject:message];
    }
    [self sendAck:ReadSeq(json) ok:NO jsReady:NO message:@"Faceclaw is not running on the phone. Open it to connect the glasses."];
}

/** The watch leaves its battery in the application context while it can't message us live. */
- (void)deliverBatteryFrom:(NSDictionary<NSString *, id> *)context {
    id json = context[kKeyBattery];
    if ([json isKindOfClass:NSString.class] && self.messageHandler) self.messageHandler(kPathBattery, json);
}

- (void)notifyConnection {
    if (self.connectionHandler) self.connectionHandler();
}

#pragma mark - WCSessionDelegate (any thread)

- (void)session:(WCSession *)session activationDidCompleteWithState:(WCSessionActivationState)state error:(NSError *)error {
    if (error) NSLog(@"[FaceclawWatch] activation failed: %@", error);
    dispatch_async(dispatch_get_main_queue(), ^{
        // Anything published before activation couldn't be delivered.
        if (self.lastState || self.heldEvent) [self pushContext];
        [self deliverBatteryFrom:session.receivedApplicationContext];
        [self notifyConnection];
    });
}

- (void)sessionDidBecomeInactive:(WCSession *)session {}

- (void)sessionDidDeactivate:(WCSession *)session {
    // The user switched watches: the session must be reactivated for the new one.
    [session activateSession];
}

- (void)sessionWatchStateDidChange:(WCSession *)session {
    dispatch_async(dispatch_get_main_queue(), ^{ [self notifyConnection]; });
}

- (void)sessionReachabilityDidChange:(WCSession *)session {
    dispatch_async(dispatch_get_main_queue(), ^{ [self notifyConnection]; });
}

- (void)session:(WCSession *)session didReceiveMessage:(NSDictionary<NSString *, id> *)message {
    id path = message[kKeyPath], json = message[kKeyJson];
    if (![path isKindOfClass:NSString.class]) return;
    NSString *body = [json isKindOfClass:NSString.class] ? json : @"{}";
    dispatch_async(dispatch_get_main_queue(), ^{ [self handleMessage:path json:body]; });
}

- (void)session:(WCSession *)session didReceiveApplicationContext:(NSDictionary<NSString *, id> *)context {
    dispatch_async(dispatch_get_main_queue(), ^{ [self deliverBatteryFrom:context]; });
}

@end
