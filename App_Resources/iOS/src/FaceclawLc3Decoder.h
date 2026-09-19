#import <Foundation/Foundation.h>
/** One decoder per capture. Stock G2 packets: 5x40 LC3 bytes, DSP trailer,
 * counter. Output: 800 mono PCM16LE samples at 16 kHz (50 ms).
 */
@interface FaceclawLc3Decoder : NSObject
- (NSData *)decodePacket:(NSData *)packet;
@property(nonatomic, readonly) NSUInteger packets;
@property(nonatomic, readonly) NSUInteger duplicates;
@property(nonatomic, readonly) NSUInteger missing;
@property(nonatomic, readonly) NSUInteger errors;
@end
