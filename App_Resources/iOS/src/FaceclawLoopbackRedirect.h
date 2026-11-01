#import <Foundation/Foundation.h>

/**
 * Catches an OAuth redirect to http://127.0.0.1:<port><path> (the loopback redirect that
 * providers such as Spotify accept from native apps): listens on the loopback interface
 * only, answers the browser's request for the path with a short "return to Faceclaw"
 * page and hands back the full redirect URL, query included. Any other path (a favicon)
 * gets a 404. Foundation-only, so the macOS test builds it as is.
 */
@interface FaceclawLoopbackRedirect : NSObject
/** Called on the main queue with each redirect to the path. */
@property(nonatomic, copy) void (^redirectHandler)(NSString *url);
/** Start listening; nil on success, otherwise why not (e.g. another app holds the port). */
- (NSString *)startOnPort:(NSInteger)port path:(NSString *)path;
- (void)stop;
@end
