#import <Foundation/Foundation.h>
@interface FaceclawCrypto : NSObject
+ (NSString *)hmacSha256:(NSString *)secret message:(NSString *)message;
+ (NSString *)sha256:(NSData *)data;
/** byteCount bytes from the system CSPRNG, base64url without padding (an OAuth state or PKCE verifier). */
+ (NSString *)randomBase64Url:(NSInteger)byteCount;
/** SHA-256 of the text's UTF-8, base64url without padding (a PKCE S256 code challenge). */
+ (NSString *)sha256Base64Url:(NSString *)text;
@end
