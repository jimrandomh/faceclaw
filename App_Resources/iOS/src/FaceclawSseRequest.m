#import "FaceclawSseRequest.h"
#import <TargetConditionals.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif

@interface FaceclawSseRequest ()
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSMutableData *buffer;
@property(nonatomic, strong) NSMutableArray *events;
@property(nonatomic) NSUInteger queuedBytes;
@property(nonatomic) NSInteger status;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL cancelled;
@property(nonatomic) BOOL firstLine;
#if TARGET_OS_IOS
@property(nonatomic) UIBackgroundTaskIdentifier backgroundTask;
#endif
@end

@implementation FaceclawSseRequest
- (instancetype)initWithURL:(NSString *)url body:(NSString *)body headers:(NSString *)headersJson {
    if ((self = [super init])) {
        _buffer = [NSMutableData new]; _events = [NSMutableArray new]; _firstLine = YES;
#if TARGET_OS_IOS
        _backgroundTask = UIBackgroundTaskInvalid;
        dispatch_async(dispatch_get_main_queue(), ^{
            @synchronized(self) {
                if (self.cancelled || self.finished) return;
                self.backgroundTask = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Assistant response" expirationHandler:^{
                    [self finish:@{@"kind": @"failure", @"text": @"iOS background time expired. Open Faceclaw and retry."}];
                    [self endBackgroundTask];
                }];
            }
        });
#endif
        NSURL *target = [NSURL URLWithString:url];
        if (!target || ![@[@"https", @"http"] containsObject:target.scheme.lowercaseString]) {
            [self finish:@{@"kind": @"failure", @"text": @"Invalid streaming URL"}]; return self;
        }
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:target];
        request.HTTPMethod = @"POST";
        request.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding];
        [request setValue:@"application/json; charset=utf-8" forHTTPHeaderField:@"Content-Type"];
        [request setValue:@"text/event-stream" forHTTPHeaderField:@"Accept"];
        NSDictionary *headers = [NSJSONSerialization JSONObjectWithData:[headersJson dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        if ([headers isKindOfClass:NSDictionary.class]) for (NSString *name in headers) {
            if ([headers[name] isKindOfClass:NSString.class]) [request setValue:headers[name] forHTTPHeaderField:name];
        }
        NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
        config.timeoutIntervalForRequest = 180;
        config.timeoutIntervalForResource = 180;
        _session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
        _task = [_session dataTaskWithRequest:request];
        [_task resume];
    }
    return self;
}
- (void)endBackgroundTask {
#if TARGET_OS_IOS
    dispatch_async(dispatch_get_main_queue(), ^{
        @synchronized(self) {
            if (self.backgroundTask == UIBackgroundTaskInvalid) return;
            [UIApplication.sharedApplication endBackgroundTask:self.backgroundTask];
            self.backgroundTask = UIBackgroundTaskInvalid;
        }
    });
#endif
}
- (void)finish:(NSDictionary *)event {
    @synchronized(self) {
        if (_finished || _cancelled) return;
        _finished = YES; [_events addObject:event];
        [_session invalidateAndCancel]; _session = nil; _task = nil;
        [_buffer setLength:0];
    }
}
- (NSString *)takeEvents {
    @synchronized(self) {
        NSData *data = [NSJSONSerialization dataWithJSONObject:_events options:0 error:nil];
        [_events removeAllObjects]; _queuedBytes = 0;
        if (_finished) [self endBackgroundTask];
        return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"[]";
    }
}
- (void)cancel {
    @synchronized(self) {
        _cancelled = YES;
        [_events removeAllObjects]; [_buffer setLength:0]; _queuedBytes = 0;
        [_session invalidateAndCancel]; _session = nil; _task = nil;
        [self endBackgroundTask];
    }
}
- (void)line:(NSData *)data {
    NSString *line = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!line) { [self finish:@{@"kind": @"failure", @"text": @"Invalid UTF-8 in streaming response"}]; return; }
    if (_firstLine && [line hasPrefix:@"\uFEFF"]) line = [line substringFromIndex:1];
    _firstLine = NO;
    _queuedBytes += data.length;
    if (_queuedBytes > 8 * 1024 * 1024 || _events.count >= 16384) {
        [_events removeAllObjects];
        [self finish:@{@"kind": @"failure", @"text": @"Streaming response queue overflow"}]; return;
    }
    [_events addObject:@{@"kind": @"line", @"text": line}];
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    @synchronized(self) { _status = [(NSHTTPURLResponse *)response statusCode]; }
    completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler {
    // Never forward provider credentials to a redirected endpoint.
    completionHandler(nil);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    @synchronized(self) {
        if (_finished || _cancelled) return;
        if (_status < 200 || _status >= 300) {
            NSUInteger remaining = 65536 - _buffer.length;
            [_buffer appendData:[data subdataWithRange:NSMakeRange(0, MIN(remaining, data.length))]];
            return;
        }
        [_buffer appendData:data];
        NSUInteger start = 0;
        const uint8_t *bytes = _buffer.bytes;
        for (NSUInteger i = 0; i < _buffer.length; i++) {
            if (bytes[i] != '\r' && bytes[i] != '\n') continue;
            if (bytes[i] == '\r' && i + 1 == _buffer.length) break;
            [self line:[_buffer subdataWithRange:NSMakeRange(start, i - start)]];
            if (_finished) return;
            if (bytes[i] == '\r' && bytes[i + 1] == '\n') i++;
            start = i + 1;
        }
        if (start) [_buffer replaceBytesInRange:NSMakeRange(0, start) withBytes:NULL length:0];
        if (_buffer.length > 2 * 1024 * 1024) [self finish:@{@"kind": @"failure", @"text": @"Streaming response line too large"}];
    }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    @synchronized(self) {
        if (_finished || _cancelled) return;
        if (error) { [self finish:@{@"kind": @"failure", @"text": error.localizedDescription}]; return; }
        if (_status < 200 || _status >= 300) {
            NSString *body = [[NSString alloc] initWithData:_buffer encoding:NSUTF8StringEncoding] ?: @"";
            [self finish:@{@"kind": @"http-error", @"code": @(_status), @"text": body}]; return;
        }
        if (_buffer.length) {
            if (((const uint8_t *)_buffer.bytes)[_buffer.length - 1] == '\r') [_buffer setLength:_buffer.length - 1];
            [self line:_buffer];
        }
        [self finish:@{@"kind": @"complete"}];
    }
}
@end
