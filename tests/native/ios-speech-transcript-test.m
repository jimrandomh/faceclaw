#import <Foundation/Foundation.h>
#import "FaceclawSpeechTranscript.h"
#include <assert.h>
static void check(NSString *actual, NSString *expected) { assert([actual isEqual:expected]); }
int main(void) { @autoreleasepool {
    FaceclawSpeechTranscript *t = [FaceclawSpeechTranscript new];
    check([t updateText:@"How" start:0 duration:0 settled:NO final:NO], @"How");
    check([t updateText:@"How are you" start:0 duration:0 settled:NO final:NO], @"How are you");
    check([t updateText:@"How are you?" start:0.5 duration:1.2 settled:YES final:NO], @"How are you?");
    check([t updateText:@"How are you?" start:0.5 duration:1.2 settled:YES final:NO], @"How are you?");
    check([t updateText:@"Fine" start:0 duration:0 settled:NO final:NO], @"How are you? Fine");
    check([t updateText:@"Fine thanks" start:0 duration:0 settled:NO final:NO], @"How are you? Fine thanks");
    check([t updateText:@"Fine, thanks." start:3 duration:1 settled:YES final:NO], @"How are you? Fine, thanks.");
    check([t updateText:@"" start:0 duration:0 settled:YES final:NO], @"How are you? Fine, thanks.");
    check([t updateText:@"Fine, thanks." start:0 duration:0 settled:YES final:YES], @"How are you? Fine, thanks.");
    // Identical utterances are real repetition, not duplicate callbacks.
    check([t updateText:@"Fine, thanks." start:0 duration:0 settled:NO final:NO], @"How are you? Fine, thanks. Fine, thanks.");
    check([t updateText:@"Fine, thanks." start:5 duration:1 settled:YES final:NO], @"How are you? Fine, thanks. Fine, thanks.");
    // Some OS/model combinations return cumulative text; retain it once.
    check([t updateText:@"How are you? Fine, thanks. Fine, thanks." start:0.5 duration:5.5 settled:YES final:NO], @"How are you? Fine, thanks. Fine, thanks.");
    t = [FaceclawSpeechTranscript new];
    check([t updateText:@"I scream" start:0.5 duration:1 settled:NO final:NO], @"I scream");
    check([t updateText:@"Ice cream" start:0.5 duration:1.1 settled:NO final:NO], @"Ice cream");
    check([t updateText:@"Ice cream is good." start:0.5 duration:2 settled:YES final:NO], @"Ice cream is good.");
    check([t updateText:@"Next sentence" start:4 duration:1 settled:NO final:NO], @"Ice cream is good. Next sentence");
    check([t updateText:@"Next sentence." start:4 duration:1 settled:YES final:NO], @"Ice cream is good. Next sentence.");
    t = [FaceclawSpeechTranscript new];
    check([t updateText:@"First sentence" start:0 duration:1 settled:YES final:NO], @"First sentence");
    check([t updateText:@"Second" start:0 duration:0 settled:NO final:NO], @"First sentence. Second");
    check([t updateText:@"Second sentence" start:2 duration:1 settled:YES final:NO], @"First sentence. Second sentence");
    check([t updateText:@"Third" start:0 duration:0 settled:NO final:NO], @"First sentence. Second sentence. Third");
    check([t updateText:@"Third" start:4 duration:1 settled:YES final:NO], @"First sentence. Second sentence. Third");
    // A cumulative final without punctuation must not erase inferred joins.
    check([t updateText:@"First sentence Second sentence Third" start:0 duration:5 settled:YES final:YES], @"First sentence. Second sentence. Third");
    // Lowercase continuation: a pause alone does not introduce a period.
    t = [FaceclawSpeechTranscript new];
    check([t updateText:@"We should" start:0 duration:1 settled:YES final:NO], @"We should");
    check([t updateText:@"keep going" start:2 duration:1 settled:YES final:NO], @"We should keep going");
    // Existing punctuation (including non-ASCII) always wins.
    for (NSString *punctuation in @[@".", @"?", @"!", @",", @":", @";", @"—", @"…", @"。", @"！"]) {
        t = [FaceclawSpeechTranscript new];
        NSString *first = [@"First" stringByAppendingString:punctuation];
        [t updateText:first start:0 duration:1 settled:YES final:NO];
        check([t updateText:@"Next" start:2 duration:1 settled:YES final:NO], [first stringByAppendingString:@" Next"]);
    }
    t = [FaceclawSpeechTranscript new];
    [t updateText:@"He said “yes”" start:0 duration:1 settled:YES final:NO];
    check([t updateText:@"“Then go”" start:2 duration:1 settled:YES final:NO], @"He said “yes.” “Then go”");
    // A revised lowercase start removes the inferred period; raw text survives.
    t = [FaceclawSpeechTranscript new];
    [t updateText:@"Keep" start:0 duration:1 settled:YES final:NO];
    check([t updateText:@"Going" start:2 duration:1 settled:NO final:NO], @"Keep. Going");
    check([t updateText:@"going" start:2 duration:1 settled:YES final:NO], @"Keep going");
    puts("PASS: utterance accumulation, live revisions, repeated words, duplicate/cumulative results and empty final callbacks");
} return 0; }
