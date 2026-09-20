#import <Foundation/Foundation.h>

/** Read-only EventKit bridge. Callbacks are delivered on the main queue. */
@interface FaceclawCalendar : NSObject
+ (instancetype)shared;
@property(nonatomic, copy) void (^changeHandler)(void);
- (BOOL)hasPermission;
- (NSString *)permissionStatus;
- (void)requestPermission:(void (^)(BOOL granted, NSString *error))completion;
- (void)readUpcomingEvents:(NSInteger)maxEvents
                 windowMs:(double)windowMs
               completion:(void (^)(NSString *json, NSString *error))completion;
@end
