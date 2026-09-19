#import <Foundation/Foundation.h>
#import "FaceclawLc3Decoder.h"
#include "lc3/lc3.h"
#include <math.h>
#include <assert.h>
int main(void) { @autoreleasepool {
    void *memory = calloc(1, lc3_encoder_size(10000, 16000));
    lc3_encoder_t encoder = lc3_setup_encoder(10000, 16000, 0, memory);
    assert(encoder);
    FaceclawLc3Decoder *decoder = [FaceclawLc3Decoder new];
    double energy = 0; NSUInteger samples = 0;
    for (int packetIndex = 0; packetIndex < 32; packetIndex++) {
        NSMutableData *packet = [NSMutableData dataWithLength:205];
        uint8_t *bytes = packet.mutableBytes;
        for (int frame = 0; frame < 5; frame++) {
            int16_t input[160];
            for (int i = 0; i < 160; i++) input[i] = (int16_t)(12000 * sin(2 * M_PI * 440 * (packetIndex * 800 + frame * 160 + i) / 16000));
            assert(lc3_encode(encoder, LC3_PCM_FORMAT_S16, input, 1, 40, bytes + frame * 40) == 0);
        }
        bytes[204] = (uint8_t)(250 + packetIndex); // Cross counter wrap.
        NSData *pcm = [decoder decodePacket:packet];
        assert(pcm.length == 1600);
        const int16_t *out = pcm.bytes;
        for (int i = 0; i < 800; i++) { energy += (double)out[i] * out[i]; samples++; }
        assert([decoder decodePacket:packet] == nil); // Other arm's relay.
        bytes[204]--; assert([decoder decodePacket:packet] == nil); // Late relay.
    }
    assert(decoder.packets == 32 && decoder.duplicates == 64 && decoder.missing == 0);
    assert(sqrt(energy / samples) > 6000 && sqrt(energy / samples) < 10000);
    assert([decoder decodePacket:[NSMutableData dataWithLength:204]] == nil);
    assert(decoder.errors == 1);
    free(memory);
    puts("PASS: LC3 G2 packets decode to 16 kHz PCM; signal energy, duplicate/late relays, counter wrap and malformed packets checked.");
} return 0; }
