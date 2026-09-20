#import <Foundation/Foundation.h>

/** Streaming POST. Events are polled by the owning JS isolate, including workers. */
@interface FaceclawSseRequest : NSObject <NSURLSessionDataDelegate>
- (instancetype)initWithURL:(NSString *)url body:(NSString *)body headers:(NSString *)headersJson;
- (NSString *)takeEvents;
- (void)cancel;
@end
