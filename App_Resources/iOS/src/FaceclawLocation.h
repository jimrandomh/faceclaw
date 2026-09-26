#import <Foundation/Foundation.h>

/** Short, foreground Core Location lookups for the glasses' true-north correction. */
@interface FaceclawLocation : NSObject
+ (instancetype)shared;
- (BOOL)hasPermission;
- (void)requestPermission:(void (^)(BOOL granted))completion;
- (void)requestPrecisePermission:(void (^)(BOOL granted))completion;
- (void)requestDeclination:(void (^)(double degrees, double latitude, double longitude, NSString *error))completion;
@end

/** Each lookup/stream owns a separate manager, so stopping one never stops another. Main thread only. */
@interface FaceclawLocationUpdates : NSObject
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
- (void)startOnce;
- (void)startTracking:(NSInteger)intervalMs;
- (void)stop;
@end
