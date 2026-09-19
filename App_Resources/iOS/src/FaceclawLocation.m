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
