#import <Foundation/Foundation.h>
/** Developer config transfer through the app container, before workers start. */
@interface FaceclawConfigPort : NSObject
+ (void)processPendingRequest;
+ (void)processDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain;
@end
