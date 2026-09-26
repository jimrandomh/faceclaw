#import "FaceclawSpeech.h"
#import "FaceclawLc3Decoder.h"
#import "FaceclawSpeechTranscript.h"
#import <FaceclawKit/FaceclawKit.h>
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
@property(atomic) BOOL accepting;
@property(nonatomic, strong) AVAudioEngine *phoneEngine;
@property(nonatomic) BOOL phoneTapInstalled;
@property(nonatomic) BOOL phoneSessionActive;
@property(nonatomic, strong) id interruptionObserver;
@property(nonatomic, copy) NSString *bestText;
@property(nonatomic, strong) FaceclawSpeechTranscript *transcript;
@property(nonatomic, strong) FaceclawKitVoiceEndpointDetector *endpointDetector;
@end
@implementation FaceclawSpeech
- (instancetype)init {
    if ((self = [super init])) _audioQueue = dispatch_queue_create("com.faceclaw.glasses-speech", DISPATCH_QUEUE_SERIAL);
    return self;
}
+ (NSInteger)microphoneAuthorizationStatus { return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]; }
+ (void)requestMicrophoneAuthorization:(void (^)(NSInteger))completion {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(granted ? 3 : 2); });
    }];
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
- (NSString *)startWithEndpointing:(BOOL)endpointing {
    return [self startWithEndpointing:endpointing phone:NO];
}
- (NSString *)startPhoneWithEndpointing:(BOOL)endpointing {
    return [self startWithEndpointing:endpointing phone:YES];
}
- (NSString *)startWithEndpointing:(BOOL)endpointing phone:(BOOL)phone {
    [self cancel];
    if (phone && [FaceclawSpeech microphoneAuthorizationStatus] != AVAuthorizationStatusAuthorized)
        return @"Allow Microphone access for Faceclaw in iPhone Settings.";
    if (SFSpeechRecognizer.authorizationStatus != SFSpeechRecognizerAuthorizationStatusAuthorized)
        return @"Allow Speech Recognition for Faceclaw in iPhone Settings.";
    NSString *language = NSLocale.preferredLanguages.firstObject ?: @"en-US";
    self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:language]];
    if (!self.recognizer.supportsOnDeviceRecognition)
        return [NSString stringWithFormat:@"On-device speech is unavailable for %@. Enable Dictation for that language in iPhone Settings → General → Keyboard, then retry.", language];
    if (!self.recognizer.available) return @"Speech recognition is temporarily unavailable. Try again shortly.";
    if (!phone) {
        self.decoder = [FaceclawLc3Decoder new];
        if (!self.decoder) return @"Could not initialize the glasses audio decoder.";
    }
    self.recognizer.queue = NSOperationQueue.mainQueue;
    self.request = [SFSpeechAudioBufferRecognitionRequest new];
    self.request.requiresOnDeviceRecognition = YES;
    self.request.shouldReportPartialResults = YES;
    self.request.taskHint = SFSpeechRecognitionTaskHintDictation;
    if (@available(iOS 16.0, *)) self.request.addsPunctuation = YES;
    self.bestText = @""; self.accepting = YES;
    self.transcript = [FaceclawSpeechTranscript new];
    self.endpointDetector = endpointing ? [FaceclawKitVoiceEndpointDetector new] : nil;
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
    if (phone) {
        NSString *error = [self startPhoneAudio];
        if (error.length) { [self cancel]; return error; }
    }
    [self emit:@{@"kind":@"status", @"message":[NSString stringWithFormat:@"Listening on %@ (%@, on-device)…", phone ? @"phone" : @"glasses", language]}];
    // Bound a dictation to the recognizer's supported short-session workflow.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 55 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        FaceclawSpeech *owner = weakSelf;
        if (owner && owner.generation == generation && owner.accepting) [owner finish];
    });
    return @"";
}
- (NSString *)startPhoneAudio {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    NSError *error = nil;
    // Leave preferredInput unset so iOS selects its current default route,
    // including a headset microphone when one is attached.
    if (![session setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeMeasurement
                     options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetoothHFP error:&error])
        return [NSString stringWithFormat:@"Could not configure phone microphone: %@", error.localizedDescription];
    if (![session setActive:YES error:&error])
        return [NSString stringWithFormat:@"Could not activate phone microphone: %@", error.localizedDescription];
    self.phoneSessionActive = YES;
    self.phoneEngine = [AVAudioEngine new];
    AVAudioInputNode *input = self.phoneEngine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.sampleRate <= 0 || !format.channelCount) return @"No phone microphone is available. Check your audio input and try again.";
    NSUInteger generation = self.generation;
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    FaceclawKitVoiceEndpointDetector *detector = self.endpointDetector;
    __weak FaceclawSpeech *weakSelf = self;
    [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        FaceclawSpeech *owner = weakSelf;
        if (!owner || owner.generation != generation || !owner.accepting || !buffer.frameLength) return;
        // The tap owns buffer only for this callback. Copy before handing it
        // to the serial recognition queue, which finish drains before endAudio.
        AVAudioPCMBuffer *copy = [[AVAudioPCMBuffer alloc] initWithPCMFormat:buffer.format frameCapacity:buffer.frameLength];
        copy.frameLength = buffer.frameLength;
        const AudioBufferList *source = buffer.audioBufferList;
        AudioBufferList *destination = copy.mutableAudioBufferList;
        for (UInt32 i = 0; i < source->mNumberBuffers; i++)
            memcpy(destination->mBuffers[i].mData, source->mBuffers[i].mData, source->mBuffers[i].mDataByteSize);
        dispatch_async(owner.audioQueue, ^{ @autoreleasepool {
            if (owner.generation != generation) return;
            [request appendAudioPCMBuffer:copy];
            double sum = 0;
            if (copy.floatChannelData) {
                const float *samples = copy.floatChannelData[0];
                NSUInteger stride = copy.format.interleaved ? copy.format.channelCount : 1;
                for (NSUInteger i = 0; i < copy.frameLength; i++) sum += samples[i * stride] * samples[i * stride];
            }
            double rms = sqrt(sum / copy.frameLength);
            // The endpoint detector uses a 16 kHz sample clock; device input
            // commonly arrives at 48 kHz. Recognition accepts its native rate.
            int32_t samples = (int32_t)llround(copy.frameLength * 16000.0 / copy.format.sampleRate);
            BOOL ended = [detector acceptLevelRms:rms * 32768.0 sampleCount:samples];
            if (ended) dispatch_async(dispatch_get_main_queue(), ^{
                if (owner.generation == generation && owner.accepting) [owner finish];
            });
        }});
    }];
    self.phoneTapInstalled = YES;
    [self.phoneEngine prepare];
    if (![self.phoneEngine startAndReturnError:&error])
        return [NSString stringWithFormat:@"Could not start phone microphone: %@", error.localizedDescription];
    self.interruptionObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionInterruptionNotification
        object:session queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
            FaceclawSpeech *owner = weakSelf;
            if (owner.generation == generation && [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan)
                [owner complete:@"Phone microphone interrupted. Start voice input again to continue."];
        }];
    return @"";
}
- (void)stopPhoneAudio {
    if (self.interruptionObserver) [NSNotificationCenter.defaultCenter removeObserver:self.interruptionObserver];
    self.interruptionObserver = nil;
    [self.phoneEngine stop];
    if (self.phoneTapInstalled) [self.phoneEngine.inputNode removeTapOnBus:0];
    self.phoneTapInstalled = NO;
    self.phoneEngine = nil;
    if (self.phoneSessionActive) [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    self.phoneSessionActive = NO;
}
- (void)acceptPacket:(NSData *)packet {
    if (!self.accepting) return;
    if (self.pendingPackets >= 40) { [self complete:@"Audio processing fell behind. Please try again."]; return; }
    self.pendingPackets++;
    NSUInteger generation = self.generation;
    FaceclawLc3Decoder *decoder = self.decoder;
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    FaceclawKitVoiceEndpointDetector *endpointDetector = self.endpointDetector;
    NSData *copy = [packet copy];
    dispatch_async(self.audioQueue, ^{ @autoreleasepool {
        if (self.generation != generation) return;
        NSData *pcm = [decoder decodePacket:copy];
        double rms = 0;
        BOOL speechEnded = NO;
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
            speechEnded = [endpointDetector acceptLevelRms:rms * 32768.0 sampleCount:(int32_t)buffer.frameLength];
        }
        NSUInteger packets = decoder.packets, errors = decoder.errors, missing = decoder.missing;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.generation != generation) return;
            self.pendingPackets--;
            if (speechEnded && self.accepting) [self finish];
            if (pcm.length && packets % 20 == 0) [self emit:@{@"kind":@"audio", @"packets":@(packets), @"seconds":@(packets * 0.05), @"rms":@(rms), @"missing":@(missing), @"errors":@(errors)}];
            if (errors > 10 && !packets) [self complete:@"Could not decode glasses audio. Reconnect the glasses and retry."];
        });
    }});
}
- (void)finish {
    if (!self.accepting) return;
    self.accepting = NO;
    [self stopPhoneAudio];
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
    [self stopPhoneAudio];
    [self.task cancel]; self.task = nil; self.request = nil; self.decoder = nil; self.recognizer = nil;
    self.bestText = @""; self.transcript = nil; self.endpointDetector = nil;
}
@end
