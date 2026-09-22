#import <Foundation/Foundation.h>
@interface FaceclawRemoteInput : NSObject
+ (instancetype)shared;
+ (NSString *)interfaces;
- (NSString *)start:(int)port;
- (NSString *)start:(int)port address:(NSString *)address;
- (void)stop;
- (void)setRequestListener:(void (^)(void))listener;
- (NSString *)nextRequest;
- (void)complete:(long long)identifier response:(NSString *)response;
- (NSString *)randomSecret;
- (NSString *)tokenDigest:(NSString *)value;
@end
