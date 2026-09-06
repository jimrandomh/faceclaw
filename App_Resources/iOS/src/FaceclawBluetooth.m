#import "FaceclawBluetooth.h"

@interface FCBPeripheral : NSObject
@property (nonatomic, strong) CBPeripheral *peripheral;
@property (nonatomic, strong) NSMutableDictionary<NSString *, CBCharacteristic *> *characteristics;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSNumber *> *subscriptions;
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *writes;
@property (nonatomic, strong) NSNumber *connectRequest;
@property (nonatomic) NSInteger pendingServices;
@property (nonatomic) BOOL awaitingWriteResponse;
@end
@implementation FCBPeripheral
- (instancetype)init {
    if ((self = [super init])) {
        _characteristics = [NSMutableDictionary new]; _subscriptions = [NSMutableDictionary new];
        _writes = [NSMutableArray new];
    }
    return self;
}
@end

@interface FaceclawBluetooth ()
@property (nonatomic, strong) CBCentralManager *central;
@property (nonatomic, strong) NSMutableDictionary<NSString *, FCBPeripheral *> *peers;
@property (nonatomic) BOOL scanRequested;
@end

@implementation FaceclawBluetooth
- (instancetype)init { if ((self = [super init])) _peers = [NSMutableDictionary new]; return self; }
- (void)emit:(NSDictionary *)event {
    if (!self.eventHandler) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (data) self.eventHandler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
- (void)complete:(NSNumber *)request error:(NSString *)error details:(NSDictionary *)details {
    if (!request) return;
    NSMutableDictionary *event = [@{ @"kind": @"completion", @"id": request } mutableCopy];
    if (error) event[@"error"] = error;
    if (details) event[@"details"] = details;
    [self emit:event];
}
- (void)initializeBluetooth {
    if (!self.central) self.central = [[CBCentralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()];
    else [self centralManagerDidUpdateState:self.central];
}
- (void)scan:(BOOL)enabled {
    self.scanRequested = enabled;
    if (!enabled) { [self.central stopScan]; return; }
    [self initializeBluetooth];
    if (self.central.state == CBManagerStatePoweredOn)
        [self.central scanForPeripheralsWithServices:nil options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @YES}];
}
- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    [self emit:@{@"kind": @"state", @"state": @(central.state), @"authorization": @(CBManager.authorization)}];
    if (central.state != CBManagerStatePoweredOn) {
        for (FCBPeripheral *peer in self.peers.allValues) [self failPeer:peer reason:@"Bluetooth is unavailable"];
    } else if (self.scanRequested) {
        [central scanForPeripheralsWithServices:nil options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @YES}];
    }
}
- (FCBPeripheral *)remember:(CBPeripheral *)peripheral {
    NSString *identifier = peripheral.identifier.UUIDString;
    FCBPeripheral *peer = self.peers[identifier];
    if (!peer) { peer = [FCBPeripheral new]; peer.peripheral = peripheral; self.peers[identifier] = peer; }
    peripheral.delegate = self;
    return peer;
}
- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral advertisementData:(NSDictionary *)advertisement RSSI:(NSNumber *)RSSI {
    [self remember:peripheral];
    NSData *data = advertisement[CBAdvertisementDataManufacturerDataKey];
    NSMutableString *hex = [NSMutableString new];
    const uint8_t *bytes = data.bytes;
    for (NSUInteger i = 0; i < data.length; i++) [hex appendFormat:@"%02x", bytes[i]];
    [self emit:@{@"kind": @"advertisement", @"identifier": peripheral.identifier.UUIDString,
        @"name": advertisement[CBAdvertisementDataLocalNameKey] ?: peripheral.name ?: @"",
        @"manufacturerData": hex, @"rssi": RSSI,
        @"connectable": advertisement[CBAdvertisementDataIsConnectable] ?: @YES}];
}
- (void)connect:(NSString *)identifier requestId:(NSInteger)requestId {
    if (self.central.state != CBManagerStatePoweredOn) { [self complete:@(requestId) error:@"Bluetooth is not ready" details:nil]; return; }
    FCBPeripheral *peer = self.peers[identifier.uppercaseString];
    if (!peer) {
        NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:identifier];
        CBPeripheral *peripheral = uuid ? [self.central retrievePeripheralsWithIdentifiers:@[uuid]].firstObject : nil;
        if (peripheral) peer = [self remember:peripheral];
    }
    if (!peer) { [self complete:@(requestId) error:@"Peripheral is unknown; scan for the device first" details:nil]; return; }
    if (peer.connectRequest || peer.peripheral.state != CBPeripheralStateDisconnected) {
        [self complete:@(requestId) error:@"Peripheral is already connecting or connected" details:nil]; return;
    }
    [peer.characteristics removeAllObjects]; peer.connectRequest = @(requestId);
    [self.central connectPeripheral:peer.peripheral options:nil];
}
- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    [peripheral discoverServices:nil];
}
- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    [self failPeer:[self remember:peripheral] reason:error.localizedDescription ?: @"Connection failed"];
}
- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    [self failPeer:[self remember:peripheral] reason:error.localizedDescription ?: @"Disconnected"];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    FCBPeripheral *peer = [self remember:peripheral];
    if (error || !peripheral.services.count) { [self failPeer:peer reason:error.localizedDescription ?: @"No services found"]; return; }
    peer.pendingServices = peripheral.services.count;
    for (CBService *service in peripheral.services) [peripheral discoverCharacteristics:nil forService:service];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
    FCBPeripheral *peer = [self remember:peripheral];
    if (!peer.connectRequest) return;
    if (error) { [self failPeer:peer reason:error.localizedDescription]; return; }
    for (CBCharacteristic *characteristic in service.characteristics) peer.characteristics[characteristic.UUID.UUIDString.lowercaseString] = characteristic;
    if (--peer.pendingServices == 0) {
        NSNumber *request = peer.connectRequest; peer.connectRequest = nil;
        [self complete:request error:nil details:@{@"characteristics": peer.characteristics.allKeys,
            @"maxWrite": @([peripheral maximumWriteValueLengthForType:CBCharacteristicWriteWithoutResponse])}];
    }
}
- (void)subscribe:(NSString *)identifier characteristic:(NSString *)uuid requestId:(NSInteger)requestId {
    FCBPeripheral *peer = self.peers[identifier.uppercaseString];
    CBCharacteristic *characteristic = peer.characteristics[uuid.lowercaseString];
    if (!characteristic || !(characteristic.properties & (CBCharacteristicPropertyNotify | CBCharacteristicPropertyIndicate))) {
        [self complete:@(requestId) error:@"Notification characteristic is unavailable" details:nil]; return;
    }
    if (characteristic.isNotifying) { [self complete:@(requestId) error:nil details:nil]; return; }
    if (peer.subscriptions[uuid.lowercaseString]) { [self complete:@(requestId) error:@"Subscription already pending" details:nil]; return; }
    peer.subscriptions[uuid.lowercaseString] = @(requestId);
    [peer.peripheral setNotifyValue:YES forCharacteristic:characteristic];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    FCBPeripheral *peer = [self remember:peripheral]; NSString *key = characteristic.UUID.UUIDString.lowercaseString;
    NSNumber *request = peer.subscriptions[key]; [peer.subscriptions removeObjectForKey:key];
    [self complete:request error:error.localizedDescription ?: (characteristic.isNotifying ? nil : @"Notifications not enabled") details:nil];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    if (error) { [self emit:@{@"kind": @"error", @"message": error.localizedDescription}]; return; }
    NSMutableString *hex = [NSMutableString new]; NSData *data = characteristic.value; const uint8_t *bytes = data.bytes;
    for (NSUInteger i = 0; i < data.length; i++) [hex appendFormat:@"%02x", bytes[i]];
    [self emit:@{@"kind": @"notification", @"identifier": peripheral.identifier.UUIDString,
        @"characteristic": characteristic.UUID.UUIDString.lowercaseString, @"data": hex}];
}
- (void)write:(NSString *)identifier characteristic:(NSString *)uuid data:(NSData *)data requestId:(NSInteger)requestId {
    FCBPeripheral *peer = self.peers[identifier.uppercaseString];
    CBCharacteristic *characteristic = peer.characteristics[uuid.lowercaseString];
    if (!characteristic || peer.peripheral.state != CBPeripheralStateConnected) {
        [self complete:@(requestId) error:@"Write characteristic is disconnected or unavailable" details:nil]; return;
    }
    CBCharacteristicWriteType type = (characteristic.properties & CBCharacteristicPropertyWriteWithoutResponse)
        ? CBCharacteristicWriteWithoutResponse : CBCharacteristicWriteWithResponse;
    if (!(characteristic.properties & (CBCharacteristicPropertyWriteWithoutResponse | CBCharacteristicPropertyWrite)) ||
        data.length > [peer.peripheral maximumWriteValueLengthForType:type]) {
        [self complete:@(requestId) error:@"Write exceeds the negotiated BLE payload size or is unsupported" details:nil]; return;
    }
    if (peer.writes.count >= 256) { [self complete:@(requestId) error:@"Bluetooth write queue is full" details:nil]; return; }
    [peer.writes addObject:@{@"id": @(requestId), @"characteristic": characteristic, @"data": [data copy], @"type": @(type)}];
    [self drain:peer];
}
- (void)drain:(FCBPeripheral *)peer {
    while (peer.writes.count && !peer.awaitingWriteResponse && peer.peripheral.state == CBPeripheralStateConnected) {
        NSDictionary *write = peer.writes.firstObject;
        CBCharacteristicWriteType type = [write[@"type"] integerValue];
        if (type == CBCharacteristicWriteWithoutResponse && !peer.peripheral.canSendWriteWithoutResponse) return;
        if (type == CBCharacteristicWriteWithResponse) peer.awaitingWriteResponse = YES;
        [peer.peripheral writeValue:write[@"data"] forCharacteristic:write[@"characteristic"] type:type];
        if (peer.awaitingWriteResponse) return;
        [peer.writes removeObjectAtIndex:0]; [self complete:write[@"id"] error:nil details:nil];
    }
}
- (void)peripheralIsReadyToSendWriteWithoutResponse:(CBPeripheral *)peripheral { [self drain:[self remember:peripheral]]; }
- (void)peripheral:(CBPeripheral *)peripheral didWriteValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    FCBPeripheral *peer = [self remember:peripheral];
    if (!peer.awaitingWriteResponse || !peer.writes.count) return;
    NSDictionary *write = peer.writes.firstObject; [peer.writes removeObjectAtIndex:0]; peer.awaitingWriteResponse = NO;
    [self complete:write[@"id"] error:error.localizedDescription details:nil]; [self drain:peer];
}
- (void)failPeer:(FCBPeripheral *)peer reason:(NSString *)reason {
    if (!peer) return;
    NSNumber *connect = peer.connectRequest; peer.connectRequest = nil;
    [self complete:connect error:reason details:nil];
    NSArray *subscriptions = peer.subscriptions.allValues; [peer.subscriptions removeAllObjects];
    NSArray *writes = [peer.writes copy]; [peer.writes removeAllObjects]; peer.awaitingWriteResponse = NO;
    for (NSNumber *request in subscriptions) [self complete:request error:reason details:nil];
    for (NSDictionary *write in writes) [self complete:write[@"id"] error:reason details:nil];
    [peer.characteristics removeAllObjects];
    if (peer.peripheral.state != CBPeripheralStateDisconnected) [self.central cancelPeripheralConnection:peer.peripheral];
    [self emit:@{@"kind": @"disconnected", @"identifier": peer.peripheral.identifier.UUIDString, @"message": reason}];
}
- (void)disconnect:(NSString *)identifier { [self failPeer:self.peers[identifier.uppercaseString] reason:@"Disconnected"]; }
@end
