#import "FaceclawGraphics.h"
#import <SVGKit/SVGKit.h>
#import <ImageIO/ImageIO.h>

@implementation FaceclawGraphics
+ (NSData *)decodeImageFile:(NSString *)path maxWidth:(NSInteger)maxWidth maxHeight:(NSInteger)maxHeight {
    if (maxWidth <= 0 || maxHeight <= 0 || maxWidth > 2048 || maxHeight > 2048) return nil;
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) return nil;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    CFRelease(source);
    double width = [properties[(id)kCGImagePropertyPixelWidth] doubleValue];
    double height = [properties[(id)kCGImagePropertyPixelHeight] doubleValue];
    if (width <= 0 || height <= 0) return nil;
    NSInteger orientation = [properties[(id)kCGImagePropertyOrientation] integerValue];
    if (orientation >= 5 && orientation <= 8) { double swap = width; width = height; height = swap; }
    double scale = MIN(1.0, MIN(maxWidth / width, maxHeight / height));
    NSInteger w = MAX(1, lround(width * scale)), h = MAX(1, lround(height * scale));
    NSData *bytes = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:nil];
    NSData *gray = [self decodeImage:bytes width:w height:h];
    if (!gray) return nil;
    // Same dimensions + pixels packet used by the shared image adapter.
    uint8_t dimensions[] = { w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255 };
    NSMutableData *packet = [NSMutableData dataWithBytes:dimensions length:4];
    [packet appendData:gray];
    return packet;
}
+ (NSData *)decodeImage:(NSData *)data width:(NSInteger)width height:(NSInteger)height {
    if (!data.length || width <= 0 || height <= 0 || width > 2048 || height > 2048) return nil;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return nil;
    NSDictionary *options = @{(id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(MAX(width, height))};
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
    if (!image) return nil;
    NSMutableData *rgba = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(rgba.mutableBytes, width, height, 8, width * 4, space,
        kCGBitmapByteOrder32Big | (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!context) { CGImageRelease(image); return nil; }
    // ImageIO applies image orientation; the bitmap's row order is top-to-bottom.
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    NSMutableData *gray = [NSMutableData dataWithLength:width * height];
    const uint8_t *src = rgba.bytes;
    uint8_t *dst = gray.mutableBytes;
    for (NSInteger i = 0; i < width * height; i++)
        dst[i] = (uint8_t)round(0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2]);
    CGContextRelease(context); CGImageRelease(image);
    return gray;
}
+ (UIImage *)preview:(NSData *)gray width:(NSInteger)width height:(NSInteger)height green:(BOOL)green {
    if (width <= 0 || height <= 0 || gray.length != width * height) return nil;
    NSMutableData *rgba = [NSMutableData dataWithLength:width * height * 4];
    const uint8_t *src = gray.bytes;
    uint8_t *dst = rgba.mutableBytes;
    uint8_t lut[256];
    for (int i = 0; i < 256; i++) lut[i] = (uint8_t)round(pow(i / 255.0, 0.7) * 255.0);
    for (NSInteger i = 0; i < width * height; i++) {
        uint8_t value = lut[src[i]];
        dst[i * 4] = green ? 0 : value;
        dst[i * 4 + 1] = value;
        dst[i * 4 + 2] = green ? 0 : value;
        dst[i * 4 + 3] = 255;
    }
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)rgba);
    CGImageRef image = CGImageCreate(width, height, 8, 32, width * 4, space,
        kCGBitmapByteOrder32Big | (CGBitmapInfo)kCGImageAlphaPremultipliedLast, provider, NULL, false, kCGRenderingIntentDefault);
    UIImage *result = image ? [UIImage imageWithCGImage:image scale:1 orientation:UIImageOrientationUp] : nil;
    if (image) CGImageRelease(image);
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(space);
    return result;
}
+ (UIImage *)whiteIcon:(NSData *)gray width:(NSInteger)width height:(NSInteger)height {
    if (width <= 0 || height <= 0 || gray.length != width * height) return nil;
    NSMutableData *rgba = [NSMutableData dataWithLength:width * height * 4];
    const uint8_t *src = gray.bytes;
    uint8_t *dst = rgba.mutableBytes;
    // Premultiplied white: every channel equals the alpha.
    for (NSInteger i = 0; i < width * height; i++) memset(dst + i * 4, src[i], 4);
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)rgba);
    CGImageRef image = CGImageCreate(width, height, 8, 32, width * 4, space,
        kCGBitmapByteOrder32Big | (CGBitmapInfo)kCGImageAlphaPremultipliedLast, provider, NULL, false, kCGRenderingIntentDefault);
    UIImage *result = image ? [UIImage imageWithCGImage:image scale:1 orientation:UIImageOrientationUp] : nil;
    if (image) CGImageRelease(image);
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(space);
    return result;
}
+ (NSData *)renderSVG:(NSString *)svg size:(NSInteger)size {
    if (size <= 0 || size > 1024) return nil;
    SVGKImage *image = [SVGKImage imageWithData:[svg dataUsingEncoding:NSUTF8StringEncoding]];
    if (!image) return nil;
    image.size = CGSizeMake(size, size);
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
    format.scale = 1;
    format.opaque = NO;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:image.size format:format];
    UIImage *raster = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        [image.CALayerTree renderInContext:context.CGContext];
    }];
    NSMutableData *rgba = [NSMutableData dataWithLength:size * size * 4];
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(rgba.mutableBytes, size, size, 8, size * 4, space,
        kCGBitmapByteOrder32Big | (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGContextDrawImage(context, CGRectMake(0, 0, size, size), raster.CGImage);
    NSMutableData *gray = [NSMutableData dataWithLength:size * size];
    const uint8_t *src = rgba.bytes;
    uint8_t *dst = gray.mutableBytes;
    // Icons are monochrome coverage masks, matching Android IconRenderer.
    // Source black/currentColor shapes must remain visible on black lenses.
    for (NSInteger i = 0; i < size * size; i++) dst[i] = src[i * 4 + 3];
    CGContextRelease(context);
    CGColorSpaceRelease(space);
    return gray;
}
+ (NSData *)bgraPacket:(CGImageRef)image maxSize:(NSInteger)maxSize {
    if (!image || maxSize <= 0 || maxSize > 1024) return nil;
    double sourceWidth = CGImageGetWidth(image), sourceHeight = CGImageGetHeight(image);
    if (sourceWidth <= 0 || sourceHeight <= 0) return nil;
    double scale = MIN(1.0, MIN(maxSize / sourceWidth, maxSize / sourceHeight));
    NSInteger width = MAX(1, lround(sourceWidth * scale)), height = MAX(1, lround(sourceHeight * scale));
    NSMutableData *packet = [NSMutableData dataWithLength:4 + width * height * 4];
    uint8_t *bytes = packet.mutableBytes;
    bytes[0] = width & 255; bytes[1] = (width >> 8) & 255;
    bytes[2] = height & 255; bytes[3] = (height >> 8) & 255;
    uint8_t *pixels = bytes + 4;
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    // Memory order B, G, R, A: one little-endian ARGB word per pixel.
    CGContextRef context = CGBitmapContextCreate(pixels, width, height, 8, width * 4, space,
        kCGBitmapByteOrder32Little | (CGBitmapInfo)kCGImageAlphaPremultipliedFirst);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);
    // Composited over black (the display's see-through background); now opaque.
    for (NSInteger i = 0; i < width * height; i++) pixels[i * 4 + 3] = 255;
    return packet;
}
+ (NSData *)bgraPacketFromImageData:(NSData *)data maxSize:(NSInteger)maxSize {
    if (!data.length || maxSize <= 0 || maxSize > 1024) return nil;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return nil;
    NSDictionary *options = @{(id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(maxSize)};
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
    if (!image) return nil;
    NSData *packet = [self bgraPacket:image maxSize:maxSize];
    CGImageRelease(image);
    return packet;
}
@end
