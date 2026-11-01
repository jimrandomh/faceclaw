#import "FaceclawLoopbackRedirect.h"
#import <arpa/inet.h>
#import <errno.h>
#import <fcntl.h>
#import <netinet/in.h>
#import <sys/socket.h>
#import <unistd.h>

/** Request heads beyond this are not a browser's redirect; stop reading. */
static const NSUInteger kMaxRequestBytes = 16384;

static NSString *const kDonePage =
    @"<!doctype html><html><head><meta charset=\"utf-8\">"
    @"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Faceclaw</title></head>"
    @"<body style=\"font-family: -apple-system, sans-serif; text-align: center; padding: 64px 24px\">"
    @"<h2>Signed in</h2><p>You can return to Faceclaw.</p></body></html>";

@interface FaceclawLoopbackRedirect ()
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) dispatch_source_t acceptSource;
@property(nonatomic) NSInteger port;
@property(nonatomic, copy) NSString *path;
@end

@implementation FaceclawLoopbackRedirect
- (instancetype)init {
    if ((self = [super init])) {
        _queue = dispatch_queue_create("com.faceclaw.loopback-redirect", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)dealloc {
    [self stop];
}

- (NSString *)startOnPort:(NSInteger)port path:(NSString *)path {
    [self stop];
    if (port <= 0 || port > 65535 || ![path hasPrefix:@"/"]) return @"Invalid redirect address";
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return [NSString stringWithFormat:@"Could not open a socket (errno %d)", errno];
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in address = {0};
    address.sin_len = sizeof(address);
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, 8) != 0) {
        int error = errno;
        close(fd);
        return error == EADDRINUSE
            ? [NSString stringWithFormat:@"Another app is using port %ld; close it and try again", (long)port]
            : [NSString stringWithFormat:@"Could not listen on port %ld (errno %d)", (long)port, error];
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    self.port = port;
    self.path = path;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, self.queue);
    __weak typeof(self) weakSelf = self;
    dispatch_source_set_event_handler(source, ^{
        int client = accept(fd, NULL, NULL);
        if (client < 0) return;
        FaceclawLoopbackRedirect *strongSelf = weakSelf;
        if (strongSelf) [strongSelf serve:client];
        else close(client);
    });
    dispatch_source_set_cancel_handler(source, ^{ close(fd); });
    self.acceptSource = source;
    dispatch_resume(source);
    return nil;
}

- (void)stop {
    if (self.acceptSource) dispatch_source_cancel(self.acceptSource);
    self.acceptSource = nil;
}

/** Read one request head and answer it; runs on the receiver's queue (blocking, with timeouts). */
- (void)serve:(int)client {
    // BSD sockets inherit O_NONBLOCK from the listener.
    fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK);
    int yes = 1;
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
    struct timeval timeout = { .tv_sec = 3, .tv_usec = 0 };
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

    NSMutableData *head = [NSMutableData data];
    NSData *terminator = [@"\r\n\r\n" dataUsingEncoding:NSASCIIStringEncoding];
    char buffer[2048];
    while (head.length < kMaxRequestBytes) {
        ssize_t count = recv(client, buffer, sizeof(buffer), 0);
        if (count <= 0) break;
        [head appendBytes:buffer length:(NSUInteger)count];
        if ([head rangeOfData:terminator options:0 range:NSMakeRange(0, head.length)].location != NSNotFound) break;
    }
    NSString *text = [[NSString alloc] initWithData:head encoding:NSUTF8StringEncoding] ?: @"";
    NSArray<NSString *> *requestLine = [[text componentsSeparatedByString:@"\r\n"].firstObject componentsSeparatedByString:@" "];
    NSString *target = requestLine.count >= 3 && [requestLine[0] isEqualToString:@"GET"] ? requestLine[1] : nil;
    BOOL matched = target && [[target componentsSeparatedByString:@"?"].firstObject isEqualToString:self.path];
    [self respond:client status:matched ? @"200 OK" : @"404 Not Found" body:matched ? kDonePage : @"Not found"];
    close(client);
    if (!matched) return;

    NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%ld%@", (long)self.port, target];
    void (^handler)(NSString *) = self.redirectHandler;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (handler) handler(url);
    });
}

- (void)respond:(int)client status:(NSString *)status body:(NSString *)body {
    NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *headers = [NSString stringWithFormat:
        @"HTTP/1.1 %@\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %lu\r\n"
        @"Cache-Control: no-store\r\nConnection: close\r\n\r\n", status, (unsigned long)bodyData.length];
    NSMutableData *response = [[headers dataUsingEncoding:NSASCIIStringEncoding] mutableCopy];
    [response appendData:bodyData];
    const uint8_t *bytes = response.bytes;
    NSUInteger sent = 0;
    while (sent < response.length) {
        ssize_t count = send(client, bytes + sent, response.length - sent, 0);
        if (count <= 0) break;
        sent += (NSUInteger)count;
    }
}
@end
