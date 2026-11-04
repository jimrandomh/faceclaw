#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Phone side of the Apple Watch remote: the single place that talks to
 * WatchConnectivity, so JS only ever sees path + JSON strings. The twin of the
 * Android FaceclawWearBridge; the messages are in wear/PROTOCOL.md.
 *
 * The session activates during launch, ahead of JS, because the watch can wake
 * this app in the background and messages arriving before a delegate exists
 * are lost. Until JS registers its handlers, messages are answered with
 * jsReady:NO so the watch can say "open Faceclaw on the phone".
 *
 * The public methods and both handlers belong to the main thread.
 */
@interface FaceclawWatchBridge : NSObject
+ (instancetype)shared;
/** WCSession works on this device (every iPhone; no iPad). */
- (BOOL)isAvailable;
/** A paired Apple Watch has the Faceclaw app. It needn't be running. */
- (BOOL)isWatchAppAvailable;
/**
 * Register JS. messageHandler gets every watch message; connectionHandler fires
 * when isWatchAppAvailable or the watch app's live reachability changes.
 */
- (void)setMessageHandler:(void (^)(NSString *path, NSString *json))messageHandler
        connectionHandler:(void (^)(void))connectionHandler;
/**
 * Mirror the dashboard state: kept in the application context for the app's
 * next launch, and sent live too while it's in front. An unchanged state is
 * dropped unless `force`.
 */
- (void)publishState:(NSString *)json force:(BOOL)force;
/** Send an event live. A sticky one also stays in the application context for a suspended app. */
- (void)sendEvent:(NSString *)json sticky:(BOOL)sticky;
/** A live message on any phone -> watch path; dropped if the watch app isn't in front. */
- (void)sendToWatch:(NSString *)path json:(NSString *)json;
/** Reply to a watch message; `seq` echoes the watch's sequence number. */
- (void)sendAck:(double)seq ok:(BOOL)ok jsReady:(BOOL)jsReady message:(NSString *)message;
@end

NS_ASSUME_NONNULL_END
