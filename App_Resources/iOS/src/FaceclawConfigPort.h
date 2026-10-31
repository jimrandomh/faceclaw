#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/** Converts between this phone's settings and the transfer document (Kotlin SettingsTransfer). */
@protocol FaceclawConfigCodec <NSObject>
/** valuesJson is a JSON object of the settings; nil when they cannot be exported. */
- (nullable NSString *)exportValuesJson:(NSString *)valuesJson platform:(NSString *)platform appVersion:(nullable NSString *)appVersion;
/** A JSON object: {"ok":true,"settings":{...},"skipped":[...],"sourcePlatform":...} or {"ok":false,"message":...}. */
- (NSString *)importPlanDocument:(NSString *)document platform:(NSString *)platform;
@end

/** Developer config transfer through the app container, before workers start (scripts/config-transfer.md). */
@interface FaceclawConfigPort : NSObject
+ (void)processPendingRequest;
+ (void)processDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain
                   codec:(id<FaceclawConfigCodec>)codec appVersion:(nullable NSString *)appVersion;
@end
NS_ASSUME_NONNULL_END
