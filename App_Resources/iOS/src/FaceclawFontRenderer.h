#import <Foundation/Foundation.h>

/** Core Text rasterizer. All sizes are glasses pixels, independent of screen scale.
 * Each operation owns its layout/context, so main and worker isolates may call it.
 * Packets match Android FontFileRenderer: grayscale image or 10-byte glyph header.
 */
@interface FaceclawFontRenderer : NSObject
+ (BOOL)canLoadFont:(NSString *)path;
+ (NSString *)getFontName:(NSString *)path;
+ (NSString *)getFontMetrics:(NSString *)path size:(double)size;
+ (double)measureTextExact:(NSString *)path text:(NSString *)text size:(double)size;
+ (NSData *)renderGlyphCell:(NSString *)path size:(double)size codePoint:(NSInteger)codePoint gamma:(double)gamma;
+ (NSData *)renderText:(NSString *)path text:(NSString *)text size:(double)size gamma:(double)gamma;
+ (NSData *)renderWrapped:(NSString *)path text:(NSString *)text size:(double)size width:(NSInteger)width gamma:(double)gamma maxLines:(NSInteger)maxLines;
@end
