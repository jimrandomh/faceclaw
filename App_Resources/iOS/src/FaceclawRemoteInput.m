#import "FaceclawRemoteInput.h"
#import "FaceclawCrypto.h"
#import <Security/Security.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>
#import <poll.h>
#import <ifaddrs.h>
#import <net/if.h>
#import <netdb.h>
#import <arpa/inet.h>

@implementation FaceclawRemoteInput {
    NSCondition *_condition;
    int _server, _client;
    NSUInteger _generation;
    long long _nextId, _requestId;
    NSTimeInterval _deadline;
    NSString *_pending, *_reply;
    void (^_requestListener)(void);
}
+ (instancetype)shared {
    static FaceclawRemoteInput *instance; static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [self new]; }); return instance;
}
- (instancetype)init {
    if ((self = [super init])) { _condition = [NSCondition new]; _server = _client = -1; }
    return self;
}
- (NSString *)start:(int)port { return [self start:port address:@"127.0.0.1"]; }
- (NSString *)start:(int)port address:(NSString *)address {
    [_condition lock];
    if (_server >= 0) { [_condition unlock]; return @""; }
    struct addrinfo hints = {0}, *resolved = NULL;
    hints.ai_flags = AI_NUMERICHOST; hints.ai_socktype = SOCK_STREAM;
    NSString *service = [NSString stringWithFormat:@"%d", port];
    if (getaddrinfo(address.UTF8String, service.UTF8String, &hints, &resolved) != 0) {
        [_condition unlock]; return @"Invalid local address.";
    }
    BOOL wildcard = resolved->ai_family == AF_INET ?
        ((struct sockaddr_in *)resolved->ai_addr)->sin_addr.s_addr == INADDR_ANY :
        IN6_IS_ADDR_UNSPECIFIED(&((struct sockaddr_in6 *)resolved->ai_addr)->sin6_addr);
    if (wildcard) { freeaddrinfo(resolved); [_condition unlock]; return @"Wildcard addresses are not allowed."; }
    int fd = socket(resolved->ai_family, SOCK_STREAM, 0), yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    int result = fd < 0 ? -1 : bind(fd, resolved->ai_addr, (socklen_t)resolved->ai_addrlen);
    freeaddrinfo(resolved);
    if (result || listen(fd, 8)) {
        if (fd >= 0) close(fd); [_condition unlock]; return @"Could not open input port on this address.";
    }
    _server = fd; NSUInteger generation = ++_generation;
    [_condition unlock];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ [self serve:fd generation:generation]; });
    return @"";
}
- (void)stop {
    [_condition lock]; ++_generation;
    // The serving thread owns close(); shutdown interrupts its blocking I/O.
    if (_server >= 0) shutdown(_server, SHUT_RDWR);
    if (_client >= 0) shutdown(_client, SHUT_RDWR);
    _server = _client = -1; _requestId = 0; _pending = _reply = nil;
    [_condition broadcast]; [_condition unlock];
}
- (NSString *)nextRequest {
    [_condition lock];
    NSString *result = NSDate.date.timeIntervalSince1970 < _deadline ? _pending : nil;
    _pending = nil; [_condition unlock]; return result;
}
- (void)setRequestListener:(void (^)(void))listener {
    [_condition lock]; _requestListener = [listener copy]; [_condition unlock];
}
- (void)notifyRequestReady:(long long)identifier {
    // Dispatch from under the condition lock; invoke JS only on the main thread,
    // outside the lock, and discard notifications invalidated by stop/timeout.
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_condition lock];
        void (^callback)(void) = self->_requestId == identifier && self->_pending &&
            NSDate.date.timeIntervalSince1970 < self->_deadline ? self->_requestListener : nil;
        [self->_condition unlock];
        if (callback) callback();
    });
}
- (void)complete:(long long)identifier response:(NSString *)response {
    [_condition lock];
    if (_requestId == identifier && NSDate.date.timeIntervalSince1970 < _deadline) { _reply = response; [_condition signal]; }
    [_condition unlock];
}
- (void)serve:(int)listener generation:(NSUInteger)generation {
    for (;;) {
        [_condition lock]; BOOL current = generation == _generation; [_condition unlock];
        if (!current) break;
        // Poll also guarantees stop is observed on platforms where shutdown does not wake accept.
        struct pollfd p = { .fd = listener, .events = POLLIN };
        if (poll(&p, 1, 250) <= 0) continue;
        int client = accept(listener, NULL, NULL);
        if (client < 0) break;
        @autoreleasepool {
            [_condition lock]; current = generation == _generation;
            if (current) _client = client;
            [_condition unlock];
            if (!current) { close(client); break; }
            struct timeval timeout = {5, 0}; int yes = 1;
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
            setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
            NSTimeInterval readDeadline = NSDate.date.timeIntervalSince1970 + 5;
            NSMutableData *body = [NSMutableData new]; unsigned char byte; BOOL complete = NO;
            while (body.length <= 65536) {
                NSTimeInterval remaining = readDeadline - NSDate.date.timeIntervalSince1970;
                struct pollfd input = { .fd = client, .events = POLLIN };
                if (remaining <= 0 || poll(&input, 1, (int)(remaining * 1000)) <= 0 || recv(client, &byte, 1, 0) != 1) break;
                if (byte == '\n') { complete = YES; break; }
                [body appendBytes:&byte length:1];
            }
            NSString *text = complete ? [[NSString alloc] initWithData:body encoding:NSUTF8StringEncoding] : nil;
            if (text) {
                [_condition lock];
                if (generation == _generation) {
                    _requestId = ++_nextId; _deadline = NSDate.date.timeIntervalSince1970 + 5; _reply = nil;
                    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"id":@(_requestId), @"expiresAt":@(_deadline * 1000), @"body":text} options:0 error:nil];
                    _pending = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
                    [self notifyRequestReady:_requestId];
                    while (!_reply && generation == _generation && NSDate.date.timeIntervalSince1970 < _deadline)
                        [_condition waitUntilDate:[NSDate dateWithTimeIntervalSince1970:_deadline]];
                    NSString *reply = _reply ?: @"{\"ok\":false,\"error\":\"timeout\",\"message\":\"Faceclaw did not respond in time.\"}";
                    if (generation == _generation) { _pending = _reply = nil; _requestId = 0; }
                    [_condition unlock];
                    NSData *data = [[reply stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
                    NSUInteger offset = 0;
                    while (offset < data.length) {
                        ssize_t n = send(client, (const char *)data.bytes + offset, data.length - offset, 0);
                        if (n <= 0) break; offset += n;
                    }
                } else [_condition unlock];
            }
            [_condition lock]; if (generation == _generation) _client = -1; [_condition unlock];
            close(client);
        }
    }
    close(listener);
    [_condition lock]; if (generation == _generation) _server = -1; [_condition unlock];
}
+ (NSString *)interfaces {
    NSMutableArray *result = [NSMutableArray new]; struct ifaddrs *interfaces = NULL;
    if (getifaddrs(&interfaces) == 0) {
        for (struct ifaddrs *item = interfaces; item; item = item->ifa_next) {
            if (!item->ifa_addr || !(item->ifa_flags & IFF_UP) || (item->ifa_flags & IFF_LOOPBACK)) continue;
            int family = item->ifa_addr->sa_family;
            if (family != AF_INET && family != AF_INET6) continue;
            char address[NI_MAXHOST];
            if (getnameinfo(item->ifa_addr, item->ifa_addr->sa_len, address, sizeof(address), NULL, 0, NI_NUMERICHOST)) continue;
            [result addObject:@{@"name":@(item->ifa_name), @"address":@(address), @"pointToPoint":@((item->ifa_flags & IFF_POINTOPOINT) != 0)}];
        }
        freeifaddrs(interfaces);
    }
    return [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] encoding:NSUTF8StringEncoding];
}
- (NSString *)randomSecret {
    unsigned char bytes[32];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) return @"";
    NSMutableString *hex = [NSMutableString new];
    for (NSUInteger i = 0; i < sizeof(bytes); i++) [hex appendFormat:@"%02x", bytes[i]];
    return hex;
}
- (NSString *)tokenDigest:(NSString *)value { return [FaceclawCrypto sha256:[value dataUsingEncoding:NSUTF8StringEncoding]]; }
@end
