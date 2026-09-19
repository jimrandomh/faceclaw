#import "FaceclawGraphics.h"
#import <SVGKit/SVGKit.h>
#import <ImageIO/ImageIO.h>

@implementation FaceclawGraphics
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
    for (NSInteger i = 0; i < size * size; i++) {
        dst[i] = (uint8_t)round(0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2]);
    }
    CGContextRelease(context);
    CGColorSpaceRelease(space);
    return gray;
}
@end
