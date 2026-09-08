#import <Foundation/Foundation.h>
/** Accumulates on-device utterances while allowing revisions within each one. */
@interface FaceclawSpeechTranscript : NSObject
@property(nonatomic, readonly) NSString *text;
- (NSString *)updateText:(NSString *)text start:(NSTimeInterval)start duration:(NSTimeInterval)duration settled:(BOOL)settled final:(BOOL)final;
@end
