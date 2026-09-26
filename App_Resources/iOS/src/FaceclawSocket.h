#import <Foundation/Foundation.h>
/** Thread-safe event queue; each NativeScript worker drains it on its own thread. */
@interface FaceclawSocket : NSObject <NSURLSessionWebSocketDelegate>
- (instancetype)initWithURL:(NSString *)url;
- (NSString *)takeEvents;
- (void)sendText:(NSString *)text;
- (void)close;
@end
