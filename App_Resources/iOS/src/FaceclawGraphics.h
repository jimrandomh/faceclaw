#import <UIKit/UIKit.h>

@interface FaceclawGraphics : NSObject
+ (UIImage *)preview:(NSData *)gray width:(NSInteger)width height:(NSInteger)height green:(BOOL)green;
+ (NSData *)renderSVG:(NSString *)svg size:(NSInteger)size;
+ (NSData *)decodeImage:(NSData *)data width:(NSInteger)width height:(NSInteger)height;
+ (NSData *)decodeImageFile:(NSString *)path maxWidth:(NSInteger)maxWidth maxHeight:(NSInteger)maxHeight;
@end
