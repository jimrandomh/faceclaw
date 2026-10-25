#import "FaceclawSocket.h"
@interface FaceclawSocket ()
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionWebSocketTask *task;
@property(nonatomic, strong) NSMutableArray *events;
@property(nonatomic) BOOL ended;
@property(nonatomic) NSUInteger queuedBytes;
@end
@implementation FaceclawSocket
- (instancetype)initWithURL:(NSString *)url {
    return [self initWithURL:url headerName:nil headerValue:nil];
}
- (instancetype)initWithURL:(NSString *)url headerName:(NSString *)headerName headerValue:(NSString *)headerValue {
    if ((self = [super init])) {
        _events = [NSMutableArray array];
        NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        config.timeoutIntervalForRequest = 20;
        _session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
        if (headerName.length && headerValue) [request setValue:headerValue forHTTPHeaderField:headerName];
        _task = [_session webSocketTaskWithRequest:request];
        _task.maximumMessageSize = 8 * 1024 * 1024;
        [_task resume];
    }
    return self;
}
- (void)enqueue:(NSDictionary *)event {
    @synchronized(self) {
        if (_ended) return;
        _queuedBytes += [event[@"text"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
        if (_events.count >= 256 || _queuedBytes > 16 * 1024 * 1024) {
            [_events removeAllObjects]; _queuedBytes = 0;
            [_events addObject:@{@"kind": @"error", @"text": @"WebSocket receive queue overflow"}];
            [self close];
        } else [_events addObject:event];
    }
}
- (NSString *)takeEvents {
    @synchronized(self) {
        NSData *data = [NSJSONSerialization dataWithJSONObject:_events options:0 error:nil];
        [_events removeAllObjects]; _queuedBytes = 0;
        return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"[]";
    }
}
- (void)receiveNext {
    __weak FaceclawSocket *weakSelf = self;
    [_task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
        FaceclawSocket *owner = weakSelf; if (!owner) return;
        @synchronized(owner) { if (owner.ended) return; }
        if (error) { [owner enqueue:@{@"kind": @"error", @"text": error.localizedDescription}]; [owner close]; return; }
        if (message.type == NSURLSessionWebSocketMessageTypeString)
            [owner enqueue:@{@"kind": @"text", @"text": message.string}];
        [owner receiveNext];
    }];
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task didOpenWithProtocol:(NSString *)protocol {
    [self enqueue:@{@"kind": @"open"}]; [self receiveNext];
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task didCloseWithCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
    [self enqueue:@{@"kind": @"closed", @"code": @(code), @"text": reason ? ([[NSString alloc] initWithData:reason encoding:NSUTF8StringEncoding] ?: @"") : @""}];
    [self close];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (error) {
        // A refused handshake only says "bad response"; name the HTTP status
        // so callers can tell a rejected key (401/403) from a network error.
        NSInteger status = [task.response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)task.response).statusCode : 0;
        NSString *text = status >= 400 ? [NSString stringWithFormat:@"HTTP %ld: %@", (long)status, error.localizedDescription] : error.localizedDescription;
        [self enqueue:@{@"kind": @"error", @"text": text}];
    }
    [self close];
}
- (void)sendText:(NSString *)text {
    __weak FaceclawSocket *weakSelf = self;
    [_task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:text] completionHandler:^(NSError *error) {
        if (error) { [weakSelf enqueue:@{@"kind": @"error", @"text": error.localizedDescription}]; [weakSelf close]; }
    }];
}
- (void)sendData:(NSData *)data {
    __weak FaceclawSocket *weakSelf = self;
    [_task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithData:data] completionHandler:^(NSError *error) {
        if (error) { [weakSelf enqueue:@{@"kind": @"error", @"text": error.localizedDescription}]; [weakSelf close]; }
    }];
}
- (void)close {
    @synchronized(self) {
        if (_ended) return; _ended = YES;
        [_task cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
        [_session invalidateAndCancel]; _session = nil;
    }
}
@end
