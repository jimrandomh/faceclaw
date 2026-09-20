#import "FaceclawLc3Decoder.h"
#include "lc3/lc3.h"
#include <stdlib.h>
@interface FaceclawLc3Decoder () {
    void *_memory;
    lc3_decoder_t _decoder;
    int _lastCounter;
}
@property(nonatomic) NSUInteger packets, duplicates, missing, errors;
@end
@implementation FaceclawLc3Decoder
- (instancetype)init {
    if ((self = [super init])) {
        _lastCounter = -1;
        _memory = calloc(1, lc3_decoder_size(10000, 16000));
        if (!_memory) return nil;
        _decoder = lc3_setup_decoder(10000, 16000, 0, _memory);
        if (!_decoder) return nil;
    }
    return self;
}
- (void)dealloc { free(_memory); }
- (NSData *)decodePacket:(NSData *)packet {
    @synchronized(self) {
        if (packet.length != 205) { _errors++; return nil; }
        const uint8_t *bytes = packet.bytes;
        int counter = bytes[204], gap = _lastCounter < 0 ? 1 : (counter - _lastCounter) & 255;
        // Both arms may relay the same packet. Drop duplicates/late copies,
        // including across the 255 -> 0 wrap, before touching decoder history.
        if (gap == 0 || gap >= 128) { _duplicates++; return nil; }
        _missing += gap - 1;
        _lastCounter = counter;
        NSMutableData *out = [NSMutableData dataWithLength:800 * sizeof(int16_t)];
        int16_t *pcm = out.mutableBytes;
        for (int frame = 0; frame < 5; frame++) {
            int status = lc3_decode(_decoder, bytes + frame * 40, 40, LC3_PCM_FORMAT_S16, pcm + frame * 160, 1);
            if (status < 0) { _errors++; return nil; }
        }
        _packets++; return out;
    }
}
@end
