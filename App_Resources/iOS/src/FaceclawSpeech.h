#import <Foundation/Foundation.h>
/** On-device speech recognition fed ONLY by decoded G2 BLE microphone packets. */
@interface FaceclawSpeech : NSObject
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
+ (NSInteger)authorizationStatus;
+ (void)requestAuthorization:(void (^)(NSInteger status))completion;
/** Returns an actionable error, or an empty string when capture starts. */
- (NSString *)start;
- (void)acceptPacket:(NSData *)packet;
- (void)finish;
- (void)cancel;
@end
