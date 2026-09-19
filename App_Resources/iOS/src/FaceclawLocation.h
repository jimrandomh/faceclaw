#import <Foundation/Foundation.h>

/** Short, foreground Core Location lookups for the glasses' true-north correction. */
@interface FaceclawLocation : NSObject
+ (instancetype)shared;
- (BOOL)hasPermission;
- (void)requestPermission:(void (^)(BOOL granted))completion;
- (void)requestDeclination:(void (^)(double degrees, double latitude, double longitude, NSString *error))completion;
@end
