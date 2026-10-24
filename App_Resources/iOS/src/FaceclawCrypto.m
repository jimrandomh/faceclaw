#import "FaceclawCrypto.h"
#import <CommonCrypto/CommonHMAC.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>

static NSString *Base64Url(NSData *data) {
    NSString *base64 = [data base64EncodedStringWithOptions:0];
    base64 = [base64 stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
    base64 = [base64 stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
    return [base64 stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

@implementation FaceclawCrypto
+ (NSString *)hmacSha256:(NSString *)secret message:(NSString *)message {
    NSData *key = [secret dataUsingEncoding:NSUTF8StringEncoding];
    NSData *data = [message dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, key.bytes, key.length, data.bytes, data.length, digest);
    return [[NSData dataWithBytes:digest length:sizeof(digest)] base64EncodedStringWithOptions:0];
}
+ (NSString *)sha256:(NSData *)data {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:64];
    for (NSUInteger i = 0; i < sizeof(digest); i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}
+ (NSString *)randomBase64Url:(NSInteger)byteCount {
    if (byteCount <= 0 || byteCount > 1024) return nil;
    NSMutableData *bytes = [NSMutableData dataWithLength:(NSUInteger)byteCount];
    if (SecRandomCopyBytes(kSecRandomDefault, bytes.length, bytes.mutableBytes) != errSecSuccess) return nil;
    return Base64Url(bytes);
}
+ (NSString *)sha256Base64Url:(NSString *)text {
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    return Base64Url([NSData dataWithBytes:digest length:sizeof(digest)]);
}
@end
