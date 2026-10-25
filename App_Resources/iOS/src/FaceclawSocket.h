#import <Foundation/Foundation.h>
/** Thread-safe event queue; each NativeScript worker drains it on its own thread. */
@interface FaceclawSocket : NSObject <NSURLSessionWebSocketDelegate>
- (instancetype)initWithURL:(NSString *)url;
/** headerName/headerValue add one handshake header (e.g. an API key); nil for none. */
- (instancetype)initWithURL:(NSString *)url headerName:(NSString *)headerName headerValue:(NSString *)headerValue;
- (NSString *)takeEvents;
- (void)sendText:(NSString *)text;
- (void)sendData:(NSData *)data;
- (void)close;
@end
