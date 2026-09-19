#import <Foundation/Foundation.h>
@interface FaceclawCrypto : NSObject
+ (NSString *)hmacSha256:(NSString *)secret message:(NSString *)message;
@end
