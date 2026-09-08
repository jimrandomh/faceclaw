#import "FaceclawSpeech.h"
#import "FaceclawLc3Decoder.h"
#import "FaceclawSpeechTranscript.h"
#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#import <math.h>

@interface FaceclawSpeech ()
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) FaceclawLc3Decoder *decoder;
@property(nonatomic, strong) dispatch_queue_t audioQueue;
@property(atomic) NSUInteger generation;
@property(nonatomic) NSUInteger pendingPackets;
@property(nonatomic) BOOL accepting;
@property(nonatomic, copy) NSString *bestText;
@property(nonatomic, strong) FaceclawSpeechTranscript *transcript;
@end
@implementation FaceclawSpeech
- (instancetype)init {
    if ((self = [super init])) _audioQueue = dispatch_queue_create("com.faceclaw.glasses-speech", DISPATCH_QUEUE_SERIAL);
    return self;
}
+ (NSInteger)authorizationStatus { return SFSpeechRecognizer.authorizationStatus; }
+ (void)requestAuthorization:(void (^)(NSInteger))completion {
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(status); });
    }];
}
- (void)emit:(NSDictionary *)event {
    if (!self.eventHandler) return;
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (json) self.eventHandler([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
}
- (NSString *)start {
    [self cancel];
    if (SFSpeechRecognizer.authorizationStatus != SFSpeechRecognizerAuthorizationStatusAuthorized)
        return @"Allow Speech Recognition for Faceclaw in iPhone Settings.";
    NSString *language = NSLocale.preferredLanguages.firstObject ?: @"en-US";
    self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:language]];
    if (!self.recognizer.supportsOnDeviceRecognition)
        return [NSString stringWithFormat:@"On-device speech is unavailable for %@. Enable Dictation for that language in iPhone Settings → General → Keyboard, then retry.", language];
    if (!self.recognizer.available) return @"Speech recognition is temporarily unavailable. Try again shortly.";
    self.decoder = [FaceclawLc3Decoder new];
    if (!self.decoder) return @"Could not initialize the glasses audio decoder.";
    self.recognizer.queue = NSOperationQueue.mainQueue;
    self.request = [SFSpeechAudioBufferRecognitionRequest new];
    self.request.requiresOnDeviceRecognition = YES;
    self.request.shouldReportPartialResults = YES;
    self.request.taskHint = SFSpeechRecognitionTaskHintDictation;
    if (@available(iOS 16.0, *)) self.request.addsPunctuation = YES;
    self.bestText = @""; self.accepting = YES;
    self.transcript = [FaceclawSpeechTranscript new];
    NSUInteger generation = self.generation;
    __weak FaceclawSpeech *weakSelf = self;
    self.task = [self.recognizer recognitionTaskWithRequest:self.request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            FaceclawSpeech *owner = weakSelf;
            if (!owner || owner.generation != generation) return;
            if (result) {
                SFSpeechRecognitionMetadata *metadata = result.speechRecognitionMetadata;
                SFTranscriptionSegment *first = result.bestTranscription.segments.firstObject;
                SFTranscriptionSegment *last = result.bestTranscription.segments.lastObject;
                NSTimeInterval start = metadata ? metadata.speechStartTimestamp : first.timestamp;
                NSTimeInterval duration = metadata ? metadata.speechDuration : last.timestamp + last.duration - start;
                owner.bestText = [owner.transcript updateText:result.bestTranscription.formattedString ?: @""
                                                       start:start duration:duration settled:metadata != nil || result.final final:result.final];
                if (!result.final) [owner emit:@{@"kind":@"transcript", @"text":owner.bestText, @"final":@NO}];
            }
            if (result.final || error) {
                NSString *message = error ? [NSString stringWithFormat:@"Speech recognition: %@", error.localizedDescription] : @"Ready to send";
                [owner complete:message];
            }
        });
    }];
    [self emit:@{@"kind":@"status", @"message":[NSString stringWithFormat:@"Listening on glasses (%@, on-device)…", language]}];
    // Bound a dictation to the recognizer's supported short-session workflow.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 55 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        FaceclawSpeech *owner = weakSelf;
        if (owner && owner.generation == generation && owner.accepting) [owner finish];
    });
    return @"";
}
- (void)acceptPacket:(NSData *)packet {
    if (!self.accepting) return;
    if (self.pendingPackets >= 40) { [self complete:@"Audio processing fell behind. Please try again."]; return; }
    self.pendingPackets++;
    NSUInteger generation = self.generation;
    FaceclawLc3Decoder *decoder = self.decoder;
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    NSData *copy = [packet copy];
    dispatch_async(self.audioQueue, ^{ @autoreleasepool {
        if (self.generation != generation) return;
        NSData *pcm = [decoder decodePacket:copy];
        double rms = 0;
        if (pcm.length) {
            AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
            AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)(pcm.length / 2)];
            buffer.frameLength = buffer.frameCapacity;
            const int16_t *samples = pcm.bytes;
            for (NSUInteger i = 0; i < buffer.frameLength; i++) {
                float value = samples[i] / 32768.0f;
                buffer.floatChannelData[0][i] = value; rms += value * value;
            }
            rms = sqrt(rms / buffer.frameLength);
            if (self.generation == generation) [request appendAudioPCMBuffer:buffer];
        }
        NSUInteger packets = decoder.packets, errors = decoder.errors, missing = decoder.missing;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.generation != generation) return;
            self.pendingPackets--;
            if (pcm.length && packets % 20 == 0) [self emit:@{@"kind":@"audio", @"packets":@(packets), @"seconds":@(packets * 0.05), @"rms":@(rms), @"missing":@(missing), @"errors":@(errors)}];
            if (errors > 10 && !packets) [self complete:@"Could not decode glasses audio. Reconnect the glasses and retry."];
        });
    }});
}
- (void)finish {
    if (!self.accepting) return;
    self.accepting = NO;
    NSUInteger generation = self.generation;
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    [self emit:@{@"kind":@"finishing"}];
    // Drain already received audio before marking the utterance complete.
    dispatch_async(self.audioQueue, ^{ if (self.generation == generation) [request endAudio]; });
    __weak FaceclawSpeech *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        FaceclawSpeech *owner = weakSelf;
        if (owner && owner.generation == generation) [owner complete:@"Ready to send"];
    });
}
- (void)complete:(NSString *)status {
    NSString *text = self.bestText ?: @"";
    [self cancel];
    NSUInteger generation = self.generation;
    if (text.length) [self emit:@{@"kind":@"transcript", @"text":text, @"final":@YES}];
    if (self.generation == generation) [self emit:@{@"kind":@"ended", @"message":status}];
}
- (void)cancel {
    self.generation++;
    self.accepting = NO; self.pendingPackets = 0;
    [self.task cancel]; self.task = nil; self.request = nil; self.decoder = nil; self.recognizer = nil;
    self.bestText = @""; self.transcript = nil;
}
@end
