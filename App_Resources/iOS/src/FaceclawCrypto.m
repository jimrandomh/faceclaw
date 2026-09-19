#import "FaceclawCrypto.h"
#import <CommonCrypto/CommonHMAC.h>
#import <CommonCrypto/CommonDigest.h>
@implementation FaceclawCrypto
+ (NSString *)hmacSha256:(NSString *)secret message:(NSString *)message {
    NSData *key = [secret dataUsingEncoding:NSUTF8StringEncoding];
    NSData *data = [message dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, key.bytes, key.length, data.bytes, data.length, digest);
    return [[NSData dataWithBytes:digest length:sizeof(digest)] base64EncodedStringWithOptions:0];
}
@end
