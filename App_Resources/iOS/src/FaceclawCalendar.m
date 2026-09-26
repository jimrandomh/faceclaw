#import "FaceclawCalendar.h"
#import <EventKit/EventKit.h>
#import <UIKit/UIKit.h>
#import <math.h>

@interface FaceclawCalendar ()
@property(nonatomic, strong) EKEventStore *store;
@property(nonatomic, strong) dispatch_queue_t queue;
@end

@implementation FaceclawCalendar
+ (instancetype)shared {
    static FaceclawCalendar *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [FaceclawCalendar new]; });
    return instance;
}
- (instancetype)init {
    if ((self = [super init])) {
        _queue = dispatch_queue_create("com.faceclaw.calendar", DISPATCH_QUEUE_SERIAL);
        _store = [EKEventStore new];
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        [center addObserver:self selector:@selector(calendarChanged:) name:EKEventStoreChangedNotification object:_store];
        // Re-query after Settings changes, calendar sync, or a timezone change.
        [center addObserver:self selector:@selector(calendarChanged:) name:UIApplicationDidBecomeActiveNotification object:nil];
        [center addObserver:self selector:@selector(calendarChanged:) name:UIApplicationSignificantTimeChangeNotification object:nil];
    }
    return self;
}
- (BOOL)hasPermission {
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    if (@available(iOS 17.0, *)) return status == EKAuthorizationStatusFullAccess;
    return status == EKAuthorizationStatusAuthorized;
}
- (NSString *)permissionStatus {
    if ([self hasPermission]) return @"granted";
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    if (status == EKAuthorizationStatusDenied) return @"denied";
    if (status == EKAuthorizationStatusRestricted) return @"restricted";
    if (@available(iOS 17.0, *)) {
        if (status == EKAuthorizationStatusWriteOnly) return @"write-only";
    }
    return @"not-determined";
}
- (void)calendarChanged:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.changeHandler) self.changeHandler();
    });
}
- (void)requestPermission:(void (^)(BOOL, NSString *))completion {
    dispatch_async(self.queue, ^{
        if ([self hasPermission]) {
            dispatch_async(dispatch_get_main_queue(), ^{ completion(YES, nil); });
            return;
        }
        void (^done)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
            dispatch_async(self.queue, ^{
                // Discard objects fetched under the previous authorization.
                [self.store reset];
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (self.changeHandler) self.changeHandler();
                    completion(granted && [self hasPermission], error.localizedDescription);
                });
            });
        };
        if (@available(iOS 17.0, *)) {
            [self.store requestFullAccessToEventsWithCompletion:done];
        } else {
            [self.store requestAccessToEntityType:EKEntityTypeEvent completion:done];
        }
    });
}
- (void)readUpcomingEvents:(NSInteger)maxEvents windowMs:(double)windowMs completion:(void (^)(NSString *, NSString *))completion {
    // EventKit queries may block. Never query on the glasses render thread.
    dispatch_async(self.queue, ^{
        if (![self hasPermission] || maxEvents <= 0 || !isfinite(windowMs) || windowMs <= 0) {
            dispatch_async(dispatch_get_main_queue(), ^{ completion(@"[]", nil); });
            return;
        }
        @try {
            NSDate *now = [NSDate date];
            // Bound the query well below EventKit's four-year predicate limit.
            NSDate *end = [now dateByAddingTimeInterval:MIN(windowMs / 1000.0, 366 * 24 * 60 * 60)];
            NSPredicate *predicate = [self.store predicateForEventsWithStartDate:now endDate:end calendars:nil];
            // EventKit expands recurring events and includes overlapping events.
            NSArray<EKEvent *> *events = [[self.store eventsMatchingPredicate:predicate]
                sortedArrayUsingComparator:^NSComparisonResult(EKEvent *a, EKEvent *b) {
                    NSComparisonResult order = [a.startDate compare:b.startDate];
                    return order == NSOrderedSame ? [(a.eventIdentifier ?: @"") compare:(b.eventIdentifier ?: @"")] : order;
                }];
            NSMutableArray *rows = [NSMutableArray new];
            for (EKEvent *event in events) {
                if (!event.startDate || !event.endDate || event.status == EKEventStatusCanceled ||
                    [event.endDate compare:now] != NSOrderedDescending || [event.startDate compare:end] != NSOrderedAscending) continue;
                [rows addObject:@{
                    @"id": event.eventIdentifier ?: @"",
                    @"title": event.title ?: @"",
                    @"startMs": @(event.startDate.timeIntervalSince1970 * 1000.0),
                    @"endMs": @(event.endDate.timeIntervalSince1970 * 1000.0),
                    @"allDay": @(event.allDay),
                    @"location": event.location ?: @"",
                    @"calendarName": event.calendar.title ?: @""
                }];
                if (rows.count >= MIN(200, maxEvents)) break;
            }
            NSError *error = nil;
            NSData *data = [NSJSONSerialization dataWithJSONObject:rows options:0 error:&error];
            NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"[]";
            dispatch_async(dispatch_get_main_queue(), ^{ completion(json, error.localizedDescription); });
        } @catch (NSException *exception) {
            dispatch_async(dispatch_get_main_queue(), ^{ completion(@"[]", exception.reason ?: @"Calendar unavailable"); });
        }
    });
}
@end
