#import <Foundation/Foundation.h>
/** On-device speech recognition fed by G2 BLE audio or the default phone microphone. */
@interface FaceclawSpeech : NSObject
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
/** 16 kHz mono PCM16LE chunks from a PCM capture, on the main queue in capture order. */
@property(nonatomic, copy) void (^pcmHandler)(NSData *pcm);
+ (NSInteger)authorizationStatus;
+ (NSInteger)microphoneAuthorizationStatus;
+ (void)requestMicrophoneAuthorization:(void (^)(NSInteger status))completion;
+ (void)requestAuthorization:(void (^)(NSInteger status))completion;
/** Returns an actionable error, or an empty string when capture starts. */
- (NSString *)startWithEndpointing:(BOOL)endpointing;
- (NSString *)startPhoneWithEndpointing:(BOOL)endpointing;
/** Capture without the recognizer (for a cloud provider): audio goes to
 * pcmHandler, and "ended" follows the last chunk. No transcript events. */
- (NSString *)startPcmCaptureWithEndpointing:(BOOL)endpointing phone:(BOOL)phone;
- (void)acceptPacket:(NSData *)packet;
- (void)finish;
- (void)cancel;
@end
