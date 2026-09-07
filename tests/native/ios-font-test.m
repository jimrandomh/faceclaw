#import <Foundation/Foundation.h>
#import "FaceclawFontRenderer.h"
#import <math.h>
static int U16(const uint8_t *p) { return p[0] | p[1] << 8; }
static int S16(const uint8_t *p) { return (int16_t)U16(p); }
static void Check(BOOL ok, NSString *message) { if (!ok) { NSLog(@"FAIL: %@", message); exit(1); } }
static void SavePGM(NSData *packet, NSString *path) {
    const uint8_t *p = packet.bytes;
    NSMutableData *out = [[NSString stringWithFormat:@"P5\n%d %d\n255\n", U16(p), U16(p + 2)] dataUsingEncoding:NSUTF8StringEncoding].mutableCopy;
    [out appendBytes:p + 4 length:packet.length - 4]; [out writeToFile:path atomically:YES];
}
int main(int argc, char **argv) { @autoreleasepool {
    Check(argc == 3, @"font directory and output directory required");
    NSString *dir = @(argv[1]), *outDir = @(argv[2]);
    NSString *font = [dir stringByAppendingPathComponent:@"Roboto-Regular.ttf"];
    NSString *bad = [outDir stringByAppendingPathComponent:@"invalid.ttf"];
    [@"not a font" writeToFile:bad atomically:YES encoding:NSUTF8StringEncoding error:nil];
    Check(![FaceclawFontRenderer canLoadFont:bad], @"invalid font rejected");
    Check(![FaceclawFontRenderer canLoadFont:@"/missing/font.ttf"], @"missing font rejected");
    Check([FaceclawFontRenderer renderGlyphCell:font size:NAN codePoint:65 gamma:1].length == 0, @"invalid size rejected");
    Check([FaceclawFontRenderer renderGlyphCell:font size:16 codePoint:0xd800 gamma:1].length == 0, @"surrogate rejected");
    NSMutableArray *metadata = [NSMutableArray new];
    for (NSString *file in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
        if (![file.pathExtension isEqual:@"ttf"]) continue;
        NSString *path = [dir stringByAppendingPathComponent:file];
        Check([FaceclawFontRenderer canLoadFont:path], file);
        NSString *name = [FaceclawFontRenderer getFontName:path];
        Check(name.length > 2, @"family/style metadata");
        [metadata addObject:@{@"file":file, @"name":name, @"metrics14":[FaceclawFontRenderer getFontMetrics:path size:14]}];
        for (NSNumber *size in @[@8, @14, @18, @32, @64]) {
            NSData *glyph = [FaceclawFontRenderer renderGlyphCell:path size:size.doubleValue codePoint:65 gamma:1];
            Check(glyph.length > 10, @"bundled glyph coverage");
            const uint8_t *p = glyph.bytes;
            Check(glyph.length == (NSUInteger)(10 + U16(p+6)*U16(p+8)), @"glyph packet dimensions");
        }
    }
    Check(metadata.count == 12, @"all twelve bundled fonts");
    NSString *mono = [dir stringByAppendingPathComponent:@"RobotoMono-Regular.ttf"];
    Check(fabs([FaceclawFontRenderer measureTextExact:mono text:@"i" size:48] - [FaceclawFontRenderer measureTextExact:mono text:@"W" size:48]) < 0.01, @"monospace widths");
    double av = [FaceclawFontRenderer measureTextExact:font text:@"AV" size:32];
    double a = [FaceclawFontRenderer measureTextExact:font text:@"A" size:32], v = [FaceclawFontRenderer measureTextExact:font text:@"V" size:32];
    Check(av < a + v, @"kerning retained");
    NSMutableDictionary *packets = [NSMutableDictionary new];
    NSArray *metrics = [[FaceclawFontRenderer getFontMetrics:font size:32] componentsSeparatedByString:@" "];
    NSInteger ascent = [metrics[0] integerValue], descent = [metrics[1] integerValue];
    for (NSString *text in @[@"A", @"g", @"j", @"É", @" "]) {
        NSData *glyph = [FaceclawFontRenderer renderGlyphCell:font size:32 codePoint:[text characterAtIndex:0] gamma:1];
        const uint8_t *g = glyph.bytes;
        Check(fabs(U16(g)/64.0 - [FaceclawFontRenderer measureTextExact:font text:text size:32]) <= 1.0/128, @"advance precision");
        NSData *line = [FaceclawFontRenderer renderText:font text:text size:32 gamma:1]; const uint8_t *p = line.bytes;
        if ([text isEqual:@" "]) { Check(glyph.length == 10 && U16(g) > 0, @"space preserves advance with no ink"); continue; }
        Check(S16(g+4) >= 0 && S16(g+4)+U16(g+8) <= ascent+descent, @"glyph inside line box");
        NSInteger shiftX = MAX(0, -S16(g+2));
        // Glyph bearings/top must place precisely the same pixels as a native
        // single-character line. Detects upside-down buffers and baseline drift.
        for (NSInteger y=0; y<U16(g+8); y++) for (NSInteger x=0; x<U16(g+6); x++) {
            NSInteger targetX = shiftX+S16(g+2)+x, targetY = S16(g+4)+y;
            Check(targetX < U16(p) && targetY < U16(p+2), @"glyph placement bounds");
            Check(g[10+y*U16(g+6)+x] == p[4+targetY*U16(p)+targetX], @"glyph and line coverage agree");
        }
        packets[text] = [glyph base64EncodedStringWithOptions:0];
    }
    NSData *light = [FaceclawFontRenderer renderGlyphCell:font size:32 codePoint:65 gamma:0.5];
    NSData *dark = [FaceclawFontRenderer renderGlyphCell:font size:32 codePoint:65 gamma:1.6];
    BOOL antialiased = NO; const uint8_t *l = light.bytes, *d = dark.bytes;
    for (NSUInteger i=10; i<light.length; i++) { Check(l[i] >= d[i], @"gamma monotonic"); if (l[i] > 0 && l[i] < 255) antialiased = YES; }
    Check(antialiased, @"antialias coverage");
    Check([FaceclawFontRenderer renderGlyphCell:font size:32 codePoint:0x1f642 gamma:1].length > 10, @"non-BMP fallback glyph");
    NSString *sample = @"AgjÉ 0123456789 — AV fi ffi";
    SavePGM([FaceclawFontRenderer renderText:font text:sample size:32 gamma:1], [outDir stringByAppendingPathComponent:@"line.pgm"]);
    NSString *paragraph = @"The quick brown fox jumps over the lazy dog.\nCafé déjà vu — 23°C. ALongWordWithoutSpacesToExerciseWrapping. More text for truncation.";
    NSData *wrapped = [FaceclawFontRenderer renderWrapped:font text:paragraph size:18 width:200 gamma:1 maxLines:3];
    Check(U16(wrapped.bytes) == 200 && U16((const uint8_t *)wrapped.bytes+2) <= 3*24, @"bounded wrapped text");
    SavePGM(wrapped, [outDir stringByAppendingPathComponent:@"wrapped.pgm"]);
    NSData *reference = [FaceclawFontRenderer renderGlyphCell:font size:14 codePoint:65 gamma:1];
    dispatch_apply(32, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^(size_t i) { (void)i; @autoreleasepool {
        Check([[FaceclawFontRenderer renderGlyphCell:font size:14 codePoint:65 gamma:1] isEqual:reference], @"concurrent workers deterministic");
    }});
    NSDictionary *result = @{@"fonts":metadata, @"glyphs32":packets, @"kernAV32":@(av-a-v)};
    [[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil] writeToFile:[outDir stringByAppendingPathComponent:@"result.json"] atomically:YES];
    NSLog(@"PASS: font loading, metadata, glyph placement, coverage, kerning, wrapping, gamma and worker concurrency");
} return 0; }
