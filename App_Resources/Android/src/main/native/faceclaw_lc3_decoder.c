#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "lc3.h"

#define G2_FRAME_BYTES 40
#define G2_FRAMES_PER_PACKET 5
#define G2_SAMPLES_PER_PACKET 800

typedef struct {
    void *mem;
    lc3_decoder_t decoder;
} faceclaw_lc3_decoder_t;

JNIEXPORT jlong JNICALL
Java_com_faceclaw_app_FaceclawLc3Decoder_nativeCreate(JNIEnv *env, jclass clazz, jint frame_us, jint sample_rate) {
    (void) env;
    (void) clazz;
    unsigned mem_size = lc3_decoder_size(frame_us, sample_rate);
    if (mem_size == 0) {
        return 0;
    }

    faceclaw_lc3_decoder_t *state = (faceclaw_lc3_decoder_t *) calloc(1, sizeof(faceclaw_lc3_decoder_t));
    if (state == NULL) {
        return 0;
    }
    state->mem = calloc(1, mem_size);
    if (state->mem == NULL) {
        free(state);
        return 0;
    }
    state->decoder = lc3_setup_decoder(frame_us, sample_rate, 0, state->mem);
    if (state->decoder == NULL) {
        free(state->mem);
        free(state);
        return 0;
    }
    return (jlong) (uintptr_t) state;
}

JNIEXPORT jint JNICALL
Java_com_faceclaw_app_FaceclawLc3Decoder_nativeDecodePacket(JNIEnv *env, jclass clazz, jlong handle, jbyteArray packet, jshortArray pcm_out) {
    (void) clazz;
    faceclaw_lc3_decoder_t *state = (faceclaw_lc3_decoder_t *) (uintptr_t) handle;
    if (state == NULL || state->decoder == NULL || packet == NULL || pcm_out == NULL) {
        return 0;
    }
    if ((*env)->GetArrayLength(env, packet) < 205 || (*env)->GetArrayLength(env, pcm_out) < G2_SAMPLES_PER_PACKET) {
        return 0;
    }

    jbyte *packet_bytes = (*env)->GetByteArrayElements(env, packet, NULL);
    jshort *pcm = (*env)->GetShortArrayElements(env, pcm_out, NULL);
    if (packet_bytes == NULL || pcm == NULL) {
        if (packet_bytes != NULL) {
            (*env)->ReleaseByteArrayElements(env, packet, packet_bytes, JNI_ABORT);
        }
        if (pcm != NULL) {
            (*env)->ReleaseShortArrayElements(env, pcm_out, pcm, JNI_ABORT);
        }
        return 0;
    }

    int ok = 1;
    for (int frame = 0; frame < G2_FRAMES_PER_PACKET; frame++) {
        const uint8_t *lc3_frame = (const uint8_t *) packet_bytes + frame * G2_FRAME_BYTES;
        int16_t *pcm_frame = (int16_t *) pcm + frame * 160;
        int rc = lc3_decode(state->decoder, lc3_frame, G2_FRAME_BYTES, LC3_PCM_FORMAT_S16, pcm_frame, 1);
        if (rc < 0) {
            ok = 0;
            break;
        }
    }

    (*env)->ReleaseByteArrayElements(env, packet, packet_bytes, JNI_ABORT);
    (*env)->ReleaseShortArrayElements(env, pcm_out, pcm, ok ? 0 : JNI_ABORT);
    return ok ? G2_SAMPLES_PER_PACKET : 0;
}

JNIEXPORT void JNICALL
Java_com_faceclaw_app_FaceclawLc3Decoder_nativeDestroy(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    faceclaw_lc3_decoder_t *state = (faceclaw_lc3_decoder_t *) (uintptr_t) handle;
    if (state == NULL) {
        return;
    }
    free(state->mem);
    free(state);
}
