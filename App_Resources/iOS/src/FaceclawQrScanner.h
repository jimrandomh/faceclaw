#import <Foundation/Foundation.h>

/** A single foreground QR scan. Completion runs once, after the camera closes. */
@interface FaceclawQrScanner : NSObject
+ (BOOL)isAvailable;
- (void)startWithCompletion:(void (^)(NSString *text, NSString *error))completion;
- (void)cancel;
@end
