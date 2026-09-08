#import "FaceclawSpeechTranscript.h"
#import <math.h>
@interface FaceclawSpeechTranscript ()
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *utterances;
@end
@implementation FaceclawSpeechTranscript
- (instancetype)init {
    if ((self = [super init])) _utterances = [NSMutableArray new];
    return self;
}
// Only infer a sentence boundary between separate recognizer utterances.
// Keep the raw hypotheses unchanged so later revisions remain authoritative.
static NSString *sentenceJoin(NSString *previous, NSString *next) {
    NSCharacterSet *openingQuotes = [NSCharacterSet characterSetWithCharactersInString:@"\"'“‘«"];
    NSUInteger first = 0;
    while (first < next.length && [openingQuotes characterIsMember:[next characterAtIndex:first]]) first++;
    if (first == next.length || ![NSCharacterSet.uppercaseLetterCharacterSet characterIsMember:[next characterAtIndex:first]]) return previous;
    NSCharacterSet *closingQuotes = [NSCharacterSet characterSetWithCharactersInString:@"\"'”’»"];
    NSUInteger end = previous.length;
    while (end && [closingQuotes characterIsMember:[previous characterAtIndex:end - 1]]) end--;
    if (!end || [NSCharacterSet.punctuationCharacterSet characterIsMember:[previous characterAtIndex:end - 1]]) return previous;
    return [NSString stringWithFormat:@"%@.%@", [previous substringToIndex:end], [previous substringFromIndex:end]];
}
- (NSString *)rawText {
    NSMutableArray *parts = [NSMutableArray new];
    for (NSDictionary *utterance in self.utterances) [parts addObject:utterance[@"text"]];
    return [parts componentsJoinedByString:@" "];
}
- (NSString *)text {
    NSMutableArray *parts = [NSMutableArray new];
    for (NSUInteger i = 0; i < self.utterances.count; i++) {
        NSString *part = self.utterances[i][@"text"];
        if (i + 1 < self.utterances.count) part = sentenceJoin(part, self.utterances[i + 1][@"text"]);
        [parts addObject:part];
    }
    return [parts componentsJoinedByString:@" "];
}
- (NSString *)updateText:(NSString *)text start:(NSTimeInterval)start duration:(NSTimeInterval)duration settled:(BOOL)settled final:(BOOL)final {
    text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    // Apple's final callback can be empty after a pause. Keep the best result.
    if (!text.length || (final && ([text isEqual:self.text] || [text isEqual:self.rawText]))) return self.text;
    BOOL timed = isfinite(start) && start >= 0 && isfinite(duration) && duration > 0;
    NSUInteger index = self.utterances.count;
    if (timed) {
        // Audio timestamps identify revisions, repeated callbacks and cumulative
        // results. Replace the covered suffix, preserving earlier utterances.
        for (NSUInteger i = 0; i < self.utterances.count; i++) {
            NSDictionary *item = self.utterances[i];
            if (![item[@"settled"] boolValue] || start < [item[@"end"] doubleValue] - 0.01) { index = i; break; }
        }
    } else if (index && (final || ![self.utterances.lastObject[@"settled"] boolValue])) {
        index--; // An ordinary partial corrects the active utterance.
    }
    // Untimed partials following a metadata-bearing result begin a new
    // utterance even when the words are identical ("yes" ... "yes").
    if (index < self.utterances.count) [self.utterances removeObjectsInRange:NSMakeRange(index, self.utterances.count - index)];
    [self.utterances addObject:@{@"text":text, @"end":@(timed ? start + duration : 0), @"settled":@(settled)}];
    return self.text;
}
@end
