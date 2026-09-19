#import "FaceclawLocation.h"
#import <CoreLocation/CoreLocation.h>
#import <math.h>

@interface FaceclawLocation () <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) NSMutableArray *permissionCallbacks;
@property(nonatomic, strong) NSMutableArray *declinationCallbacks;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) CLLocation *location;
@property(nonatomic, strong) CLHeading *heading;
@end

@implementation FaceclawLocation
+ (instancetype)shared {
    static FaceclawLocation *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [FaceclawLocation new]; });
    return instance;
}
- (instancetype)init {
    if ((self = [super init])) {
        _permissionCallbacks = [NSMutableArray new];
        _declinationCallbacks = [NSMutableArray new];
        _manager = [CLLocationManager new];
        _manager.delegate = self;
        _manager.desiredAccuracy = kCLLocationAccuracyKilometer;
    }
    return self;
}
- (BOOL)hasPermission {
    CLAuthorizationStatus status = self.manager.authorizationStatus;
    return status == kCLAuthorizationStatusAuthorizedAlways || status == kCLAuthorizationStatusAuthorizedWhenInUse;
}
- (void)requestPermission:(void (^)(BOOL))completion {
    if (self.manager.authorizationStatus != kCLAuthorizationStatusNotDetermined) {
        completion([self hasPermission]);
        return;
    }
    [self.permissionCallbacks addObject:[completion copy]];
    [self.manager requestWhenInUseAuthorization];
}
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    if (manager.authorizationStatus == kCLAuthorizationStatusNotDetermined) return;
    NSArray *callbacks = [self.permissionCallbacks copy];
    [self.permissionCallbacks removeAllObjects];
    for (void (^callback)(BOOL) in callbacks) callback([self hasPermission]);
    if (![self hasPermission]) [self finishWithError:@"Location permission is required for true north"];
}
- (void)requestPrecisePermission:(void (^)(BOOL))completion {
    [self requestPermission:^(BOOL granted) {
        if (!granted || self.manager.accuracyAuthorization == CLAccuracyAuthorizationFullAccuracy) {
            completion(granted);
            return;
        }
        [self.manager requestTemporaryFullAccuracyAuthorizationWithPurposeKey:@"Navigation" completion:^(NSError *error) {
            completion([self hasPermission] && self.manager.accuracyAuthorization == CLAccuracyAuthorizationFullAccuracy);
        }];
    }];
}
- (void)requestDeclination:(void (^)(double, double, double, NSString *))completion {
    if (![self hasPermission] || ![CLLocationManager headingAvailable]) {
        completion(0, 0, 0, @"Location or heading unavailable for true north");
        return;
    }
    [self.declinationCallbacks addObject:[completion copy]];
    if (self.timer) return;
    self.location = nil;
    self.heading = nil;
    // trueHeading is valid only while the same manager receives location updates.
    // Subtracting magneticHeading cancels the phone's orientation: the result is
    // a local correction to the GLASSES heading, never the phone's heading.
    [self.manager startUpdatingLocation];
    [self.manager startUpdatingHeading];
    self.timer = [NSTimer scheduledTimerWithTimeInterval:20 repeats:NO block:^(NSTimer *timer) {
        [self finishWithError:@"Timed out obtaining the true-north correction"];
    }];
}
- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
    CLLocation *location = locations.lastObject;
    if (!location || location.horizontalAccuracy < 0 || fabs(location.timestamp.timeIntervalSinceNow) > 60) return;
    self.location = location;
    [self finishIfReady];
}
- (void)locationManager:(CLLocationManager *)manager didUpdateHeading:(CLHeading *)heading {
    if (heading.headingAccuracy < 0 || heading.trueHeading < 0 || heading.magneticHeading < 0 ||
        fabs(heading.timestamp.timeIntervalSinceNow) > 60) return;
    self.heading = heading;
    [self finishIfReady];
}
- (BOOL)locationManagerShouldDisplayHeadingCalibration:(CLLocationManager *)manager { return NO; }
- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
    if (error.code != kCLErrorLocationUnknown) [self finishWithError:error.localizedDescription];
}
- (void)finishIfReady {
    if (self.location && self.heading) [self finishWithError:@""];
}
- (void)finishWithError:(NSString *)error {
    double degrees = self.heading.trueHeading - self.heading.magneticHeading;
    if (degrees > 180) degrees -= 360;
    if (degrees < -180) degrees += 360;
    CLLocationCoordinate2D coordinate = self.location.coordinate;
    NSArray *callbacks = [self.declinationCallbacks copy];
    [self.declinationCallbacks removeAllObjects];
    [self.timer invalidate]; self.timer = nil;
    [self.manager stopUpdatingLocation];
    [self.manager stopUpdatingHeading];
    self.location = nil; self.heading = nil;
    for (void (^callback)(double, double, double, NSString *) in callbacks)
        callback(degrees, coordinate.latitude, coordinate.longitude, error);
}
@end

@interface FaceclawLocationUpdates () <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) NSTimer *timeout;
@property(nonatomic) BOOL running;
@property(nonatomic) BOOL once;
@property(nonatomic) NSTimeInterval interval;
@property(nonatomic) NSTimeInterval lastTimestamp;
@end

@implementation FaceclawLocationUpdates
- (void)startOnce { [self start:YES interval:0]; }
- (void)startTracking:(NSInteger)intervalMs { [self start:NO interval:MAX(500, intervalMs) / 1000.0]; }
- (void)start:(BOOL)once interval:(NSTimeInterval)interval {
    if (self.running) return;
    self.once = once; self.interval = interval; self.lastTimestamp = 0;
    self.manager = [CLLocationManager new];
    self.manager.delegate = self;
    CLAuthorizationStatus status = self.manager.authorizationStatus;
    if (status != kCLAuthorizationStatusAuthorizedAlways && status != kCLAuthorizationStatusAuthorizedWhenInUse) {
        [self fail:@"Location permission is required. Allow location in the phone's Settings, then retry."]; return;
    }
    if (!once && self.manager.accuracyAuthorization != CLAccuracyAuthorizationFullAccuracy) {
        [self fail:@"Precise location is required for navigation. Enable Precise Location in the phone's Settings."]; return;
    }
    self.running = YES;
    self.manager.desiredAccuracy = once ? kCLLocationAccuracyKilometer : kCLLocationAccuracyBestForNavigation;
    self.manager.distanceFilter = kCLDistanceFilterNone;
    if (!once) {
        self.manager.activityType = CLActivityTypeOtherNavigation;
        self.manager.pausesLocationUpdatesAutomatically = NO;
        self.manager.allowsBackgroundLocationUpdates = YES;
        self.manager.showsBackgroundLocationIndicator = YES;
    }
    [self.manager startUpdatingLocation];
    if (once) self.timeout = [NSTimer scheduledTimerWithTimeInterval:20 repeats:NO block:^(NSTimer *timer) {
        [self fail:@"Couldn't get a current location. Check Location Services and retry."];
    }];
}
- (void)stop {
    self.running = NO;
    [self.timeout invalidate]; self.timeout = nil;
    [self.manager stopUpdatingLocation];
    self.manager.delegate = nil; self.manager = nil;
    self.eventHandler = nil;
}
- (void)emit:(NSDictionary *)event {
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (data && self.eventHandler) self.eventHandler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
- (void)fail:(NSString *)message {
    void (^handler)(NSString *) = self.eventHandler;
    [self stop];
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"error": message} options:0 error:nil];
    if (handler) handler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    if (!self.running) return;
    CLAuthorizationStatus status = manager.authorizationStatus;
    if (status == kCLAuthorizationStatusDenied || status == kCLAuthorizationStatusRestricted ||
        (!self.once && manager.accuracyAuthorization != CLAccuracyAuthorizationFullAccuracy))
        [self fail:@"Location permission changed. Allow precise location in the phone's Settings, then retry."];
}
- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
    if (!self.running) return;
    CLLocation *fix = locations.lastObject;
    if (!fix || fix.horizontalAccuracy < 0 || fabs(fix.timestamp.timeIntervalSinceNow) > 60) return;
    NSTimeInterval timestamp = fix.timestamp.timeIntervalSince1970;
    if (self.lastTimestamp && timestamp - self.lastTimestamp < self.interval) return;
    self.lastTimestamp = timestamp;
    NSDictionary *event = @{@"latitude": @(fix.coordinate.latitude), @"longitude": @(fix.coordinate.longitude),
        @"accuracyMeters": @(fix.horizontalAccuracy), @"timestampMs": @(timestamp * 1000),
        @"bearingDeg": fix.course >= 0 ? @(fix.course) : NSNull.null,
        @"speedMps": fix.speed >= 0 ? @(fix.speed) : NSNull.null};
    if (self.once) {
        void (^handler)(NSString *) = self.eventHandler;
        [self stop];
        NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
        if (handler) handler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
    } else [self emit:event];
}
- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
    if (self.running && error.code != kCLErrorLocationUnknown) [self fail:error.localizedDescription];
}
@end
