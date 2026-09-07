#import "FaceclawFontRenderer.h"
#import <CoreText/CoreText.h>
#import <CoreGraphics/CoreGraphics.h>
#import <math.h>

// Immutable font descriptors may be shared; layout objects never cross threads.
static CTFontRef CreateFont(NSString *path, double size) CF_RETURNS_RETAINED {
    if (!path.length || !isfinite(size) || size <= 0 || size > 512) return NULL;
    static NSCache *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cache = [NSCache new]; cache.countLimit = 32; });
    NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    if (![attrs[NSFileType] isEqual:NSFileTypeRegular]) return NULL;
    NSString *key = [NSString stringWithFormat:@"%@:%@:%@", path, attrs[NSFileSize], attrs[NSFileModificationDate]];
    id descriptor = [cache objectForKey:key];
    if (!descriptor) {
        NSArray *descriptors = CFBridgingRelease(CTFontManagerCreateFontDescriptorsFromURL((__bridge CFURLRef)[NSURL fileURLWithPath:path]));
        descriptor = descriptors.firstObject; // TTC: first face, matching Android.
        if (!descriptor) return NULL; // Never silently substitute a system font for an invalid file.
        [cache setObject:descriptor forKey:key];
    }
    return CTFontCreateWithFontDescriptor((__bridge CTFontDescriptorRef)descriptor, size, NULL);
}
static NSAttributedString *Attributed(CTFontRef font, NSString *text, BOOL glyphLayout) {
    NSMutableDictionary *attrs = [@{(__bridge id)kCTFontAttributeName: (__bridge id)font,
        (__bridge id)kCTForegroundColorFromContextAttributeName: @YES} mutableCopy];
    // Shared UI lays out codepoints with pair kerning. Whole preview paragraphs
    // can use normal ligatures/shaping; UI measurements must match glyph cells.
    if (glyphLayout) attrs[(__bridge id)kCTLigatureAttributeName] = @0;
    return [[NSAttributedString alloc] initWithString:text attributes:attrs];
}
static BOOL ValidText(NSString *text) { return text != nil && text.length <= 100000; }
static BOOL ValidRaster(NSInteger width, NSInteger height) {
    return width > 0 && height > 0 && width <= 65535 && height <= 65535 && width * height <= 4000000;
}
static CGContextRef CreateContext(NSMutableData *pixels, NSInteger width, NSInteger height) CF_RETURNS_RETAINED {
    CGContextRef ctx = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, width, NULL, (CGBitmapInfo)kCGImageAlphaOnly);
    if (ctx) {
        CGContextSetShouldAntialias(ctx, true);
        CGContextSetShouldSmoothFonts(ctx, false); // Grayscale coverage, never LCD subpixel color.
        CGContextSetShouldSubpixelPositionFonts(ctx, true);
        CGContextSetShouldSubpixelQuantizeFonts(ctx, false);
        CGContextSetTextMatrix(ctx, CGAffineTransformIdentity);
        CGContextSetGrayFillColor(ctx, 1, 1);
    }
    return ctx;
}
static void U16(uint8_t *out, NSInteger value) { out[0] = value & 255; out[1] = (value >> 8) & 255; }
static void GammaCopy(uint8_t *dst, const uint8_t *src, NSInteger count, double gamma) {
    if (!isfinite(gamma) || gamma <= 0) gamma = 1;
    uint8_t lut[256];
    for (int i = 0; i < 256; i++) lut[i] = (uint8_t)lround(255 * pow(i / 255.0, gamma));
    for (NSInteger i = 0; i < count; i++) dst[i] = lut[src[i]];
}
static NSData *ImagePacket(NSData *pixels, NSInteger width, NSInteger height, double gamma) {
    NSMutableData *out = [NSMutableData dataWithLength:4 + pixels.length];
    uint8_t *dst = out.mutableBytes;
    U16(dst, width); U16(dst + 2, height);
    GammaCopy(dst + 4, pixels.bytes, pixels.length, gamma);
    return out;
}

@implementation FaceclawFontRenderer
+ (BOOL)canLoadFont:(NSString *)path {
    CTFontRef font = CreateFont(path, 16);
    if (!font) return NO;
    CFRelease(font); return YES;
}
+ (NSString *)getFontName:(NSString *)path {
    CTFontRef font = CreateFont(path, 16);
    if (!font) return @"";
    NSString *family = CFBridgingRelease(CTFontCopyFamilyName(font));
    NSString *style = CFBridgingRelease(CTFontCopyName(font, kCTFontStyleNameKey));
    CFRelease(font);
    return [NSString stringWithFormat:@"%@\n%@", family ?: @"", style ?: @""];
}
+ (NSString *)getFontMetrics:(NSString *)path size:(double)size {
    CTFontRef font = CreateFont(path, size);
    if (!font) return @"";
    NSString *metrics = [NSString stringWithFormat:@"%ld %ld %ld", (long)ceil(CTFontGetAscent(font)),
        (long)ceil(CTFontGetDescent(font)), (long)ceil(MAX(0, CTFontGetLeading(font)))];
    CFRelease(font); return metrics;
}
+ (double)measureTextExact:(NSString *)path text:(NSString *)text size:(double)size {
    if (!ValidText(text)) return 0;
    CTFontRef font = CreateFont(path, size);
    if (!font) return 0;
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)Attributed(font, text, YES));
    double width = CTLineGetTypographicBounds(line, NULL, NULL, NULL);
    CFRelease(line); CFRelease(font); return width;
}
+ (NSData *)renderGlyphCell:(NSString *)path size:(double)size codePoint:(NSInteger)cp gamma:(double)gamma {
    if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return [NSData data];
    CTFontRef font = CreateFont(path, size);
    if (!font) return [NSData data];
    uint32_t scalar = (uint32_t)cp;
    NSString *text = [[NSString alloc] initWithBytes:&scalar length:4 encoding:NSUTF32LittleEndianStringEncoding];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)Attributed(font, text, YES));
    double advance = CTLineGetTypographicBounds(line, NULL, NULL, NULL);
    NSMutableData *out = [NSMutableData dataWithLength:10];
    U16(out.mutableBytes, MAX(0, MIN(65535, lround(advance * 64))));
    CGRect bounds = CTLineGetImageBounds(line, NULL);
    if (!CGRectIsEmpty(bounds) && !CGRectIsNull(bounds)) {
        NSInteger left = floor(CGRectGetMinX(bounds)) - 2, top = ceil(CGRectGetMaxY(bounds)) + 2;
        NSInteger bottom = floor(CGRectGetMinY(bounds)) - 2;
        NSInteger width = ceil(CGRectGetMaxX(bounds)) + 2 - left, height = top - bottom;
        if (!ValidRaster(width, height)) { CFRelease(line); CFRelease(font); return [NSData data]; }
        NSMutableData *pixels = [NSMutableData dataWithLength:width * height];
        CGContextRef ctx = CreateContext(pixels, width, height);
        if (!ctx) { CFRelease(line); CFRelease(font); return [NSData data]; }
        CGContextSetTextPosition(ctx, -left, -bottom); CTLineDraw(line, ctx); CGContextRelease(ctx);
        const uint8_t *src = pixels.bytes;
        NSInteger x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (NSInteger y = 0; y < height; y++) for (NSInteger x = 0; x < width; x++) if (src[y * width + x]) {
            x0 = MIN(x0, x); x1 = MAX(x1, x); y0 = MIN(y0, y); y1 = MAX(y1, y);
        }
        if (x1 >= x0) {
            NSInteger w = x1 - x0 + 1, h = y1 - y0 + 1;
            [out setLength:10 + w * h]; uint8_t *dst = out.mutableBytes;
            U16(dst + 2, left + x0); U16(dst + 4, ceil(CTFontGetAscent(font)) - top + y0);
            U16(dst + 6, w); U16(dst + 8, h);
            for (NSInteger y = 0; y < h; y++) GammaCopy(dst + 10 + y * w, src + (y0 + y) * width + x0, w, gamma);
        }
    }
    CFRelease(line); CFRelease(font); return out;
}
+ (NSData *)renderText:(NSString *)path text:(NSString *)text size:(double)size gamma:(double)gamma {
    if (!ValidText(text)) return [NSData data];
    CTFontRef font = CreateFont(path, size);
    if (!font) return [NSData data];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)Attributed(font, text, NO));
    CGRect bounds = CTLineGetImageBounds(line, NULL);
    BOOL ink = !CGRectIsNull(bounds) && !CGRectIsEmpty(bounds);
    NSInteger left = ink ? MIN(0, floor(CGRectGetMinX(bounds))) : 0;
    NSInteger right = MAX(1, ceil(CTLineGetTypographicBounds(line, NULL, NULL, NULL)));
    NSInteger top = ceil(CTFontGetAscent(font)), bottom = -ceil(CTFontGetDescent(font));
    if (ink) { right = MAX(right, ceil(CGRectGetMaxX(bounds))); top = MAX(top, ceil(CGRectGetMaxY(bounds))); bottom = MIN(bottom, floor(CGRectGetMinY(bounds))); }
    NSInteger width = right - left, height = top - bottom;
    NSData *result = [NSData data];
    if (ValidRaster(width, height)) {
        NSMutableData *pixels = [NSMutableData dataWithLength:width * height];
        CGContextRef ctx = CreateContext(pixels, width, height);
        if (ctx) {
            CGContextSetTextPosition(ctx, -left, -bottom); CTLineDraw(line, ctx); CGContextRelease(ctx);
            result = ImagePacket(pixels, width, height, gamma);
        }
    }
    CFRelease(line); CFRelease(font); return result;
}
+ (NSData *)renderWrapped:(NSString *)path text:(NSString *)text size:(double)size width:(NSInteger)width gamma:(double)gamma maxLines:(NSInteger)maxLines {
    if (!ValidText(text) || width <= 0 || width > 65535 || maxLines <= 0) return [NSData data];
    CTFontRef font = CreateFont(path, size);
    if (!font) return [NSData data];
    NSInteger ascent = ceil(CTFontGetAscent(font)), descent = ceil(CTFontGetDescent(font));
    NSInteger step = MAX(1, ascent + descent + (NSInteger)ceil(MAX(0, CTFontGetLeading(font))));
    maxLines = MIN(maxLines, MIN(65535 / step, 4000000 / width / step));
    if (maxLines <= 0) { CFRelease(font); return [NSData data]; }
    NSAttributedString *attributed = Attributed(font, text, NO);
    CTTypesetterRef typesetter = CTTypesetterCreateWithAttributedString((__bridge CFAttributedStringRef)attributed);
    NSMutableArray *lines = [NSMutableArray new];
    CFIndex start = 0;
    while (start < (CFIndex)text.length && lines.count < (NSUInteger)maxLines) {
        CFIndex count = CTTypesetterSuggestLineBreak(typesetter, start, width);
        if (count <= 0) count = [text rangeOfComposedCharacterSequenceAtIndex:start].length;
        CTLineRef line;
        if (lines.count == (NSUInteger)maxLines - 1 && start + count < (CFIndex)text.length) {
            NSString *rest = [[text substringFromIndex:start] stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
            CTLineRef full = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)Attributed(font, rest, NO));
            CTLineRef token = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)Attributed(font, @"…", NO));
            line = CTLineCreateTruncatedLine(full, width, kCTLineTruncationEnd, token);
            if (!line) line = CFRetain(token);
            CFRelease(full); CFRelease(token);
        } else line = CTTypesetterCreateLine(typesetter, CFRangeMake(start, count));
        [lines addObject:CFBridgingRelease(line)]; start += count;
    }
    NSInteger height = MAX(1, lines.count) * step;
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height];
    CGContextRef ctx = CreateContext(pixels, width, height);
    NSData *result = [NSData data];
    if (ctx) {
        for (NSUInteger i = 0; i < lines.count; i++) {
            CGContextSetTextPosition(ctx, 0, height - ascent - i * step);
            CTLineDraw((__bridge CTLineRef)lines[i], ctx);
        }
        CGContextRelease(ctx); result = ImagePacket(pixels, width, height, gamma);
    }
    CFRelease(typesetter); CFRelease(font); return result;
}
@end
