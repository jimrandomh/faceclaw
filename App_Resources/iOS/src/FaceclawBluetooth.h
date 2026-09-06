#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>

/** Main-queue CoreBluetooth adapter. Protocol and MAC matching live in TS. */
@interface FaceclawBluetooth : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
@property (nonatomic, copy) void (^eventHandler)(NSString *json);
- (void)initializeBluetooth;
- (void)scan:(BOOL)enabled;
- (void)connect:(NSString *)identifier requestId:(NSInteger)requestId;
- (void)subscribe:(NSString *)identifier characteristic:(NSString *)uuid requestId:(NSInteger)requestId;
- (void)write:(NSString *)identifier characteristic:(NSString *)uuid data:(NSData *)data requestId:(NSInteger)requestId;
- (void)disconnect:(NSString *)identifier;
@end
