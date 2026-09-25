#import <Foundation/Foundation.h>
/** On-device speech recognition fed by G2 BLE audio or the default phone microphone. */
@interface FaceclawSpeech : NSObject
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
+ (NSInteger)authorizationStatus;
+ (NSInteger)microphoneAuthorizationStatus;
+ (void)requestMicrophoneAuthorization:(void (^)(NSInteger status))completion;
+ (void)requestAuthorization:(void (^)(NSInteger status))completion;
/** Returns an actionable error, or an empty string when capture starts. */
- (NSString *)startWithEndpointing:(BOOL)endpointing;
- (NSString *)startPhoneWithEndpointing:(BOOL)endpointing;
- (void)acceptPacket:(NSData *)packet;
- (void)finish;
- (void)cancel;
@end
