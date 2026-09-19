// JNI bridge for the on-phone assistant model (llama.cpp, CPU inference).
// Java surface: FaceclawLlamaRunner's nativeLoadModel / nativeGenerate /
// nativeCancel / nativeFree. One model+context per handle; the Java side
// serializes all calls except nativeCancel onto a single executor thread,
// so only the cancel flag needs to be thread-safe.

#include <jni.h>
#include <android/log.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "ggml-cpu.h"
#include "llama.h"

#define TAG "FaceclawLlama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

namespace {

struct FcLlama {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    ggml_threadpool * threadpool = nullptr;
    const llama_vocab * vocab = nullptr;
    int n_ctx = 0;
    // Tokens currently materialized in the KV cache (prompt + generated),
    // used to skip re-decoding the common prefix on the next call. Within a
    // turn the next prompt extends the previous one, so this usually reduces
    // prefill to just the new tool results.
    std::vector<llama_token> cache_tokens;
    std::atomic<bool> cancel{false};
};

void android_llama_log(ggml_log_level level, const char * text, void * /*user*/) {
    if (level < GGML_LOG_LEVEL_WARN) return; // llama.cpp is chatty at INFO during load
    __android_log_write(level >= GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN, TAG, text);
}

void ensure_backend_init() {
    static std::once_flag once;
    std::call_once(once, [] {
        llama_log_set(android_llama_log, nullptr);
        llama_backend_init();
    });
}

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

// Big-core detection for big.LITTLE phones. Without explicit affinity the
// scheduler is free to put our compute threads on the little cores (in-order
// A55s on Tensor G2), which slows prefill by 5-10x; pin to the cores whose
// max frequency is within 75% of the fastest core's (on a Pixel 7/7a this
// selects the 2x X1 + 2x A78 and excludes the 4x A55).
std::vector<int> detect_fast_cpus() {
    std::vector<long> freqs;
    for (int cpu = 0; cpu < GGML_MAX_N_THREADS; cpu++) {
        char path[128];
        snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/cpufreq/cpuinfo_max_freq", cpu);
        FILE * f = fopen(path, "r");
        if (f == nullptr) break;
        long freq = 0;
        if (fscanf(f, "%ld", &freq) != 1) freq = 0;
        fclose(f);
        freqs.push_back(freq);
    }
    std::vector<int> fast;
    long max_freq = 0;
    for (long f : freqs) max_freq = std::max(max_freq, f);
    if (max_freq <= 0) return fast;
    for (size_t cpu = 0; cpu < freqs.size(); cpu++) {
        if (freqs[cpu] * 4 >= max_freq * 3) fast.push_back((int) cpu);
    }
    // A uniform-frequency CPU has no little cores to avoid.
    if (fast.size() == freqs.size()) fast.clear();
    return fast;
}

std::string jstring_to_utf8(JNIEnv * env, jstring value) {
    if (value == nullptr) return "";
    const char * chars = env->GetStringUTFChars(value, nullptr);
    std::string out = chars ? chars : "";
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

// Callback shims into the Java listener (an in-process wrapper object that
// posts to the JS thread; these calls happen on the executor thread).
struct Listener {
    JNIEnv * env;
    jobject obj;
    jmethodID on_token;
    jmethodID on_done;
    jmethodID on_error;

    static Listener resolve(JNIEnv * env, jobject listener) {
        jclass cls = env->GetObjectClass(listener);
        return Listener{
            env,
            listener,
            env->GetMethodID(cls, "onToken", "(Ljava/lang/String;)V"),
            env->GetMethodID(cls, "onDone", "(Ljava/lang/String;)V"),
            env->GetMethodID(cls, "onError", "(Ljava/lang/String;)V"),
        };
    }

    void token(const std::string & piece) const { call(on_token, piece); }
    void done(const char * reason) const { call(on_done, reason); }
    void error(const std::string & message) const { call(on_error, message); }

  private:
    void call(jmethodID method, const std::string & text) const {
        jstring jtext = env->NewStringUTF(text.c_str());
        env->CallVoidMethod(obj, method, jtext);
        env->DeleteLocalRef(jtext);
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
        }
    }
};

// NewStringUTF aborts on invalid (modified-)UTF-8, and token pieces can end
// mid-codepoint, so hold back any incomplete trailing UTF-8 sequence.
size_t utf8_complete_prefix(const std::string & data) {
    size_t len = data.size();
    size_t i = len;
    // Find the start byte of the final codepoint (at most 3 bytes back).
    while (i > 0 && len - i < 4 && (static_cast<unsigned char>(data[i - 1]) & 0xC0) == 0x80) i--;
    if (i == 0) return len; // malformed; let it through rather than stall
    unsigned char start = static_cast<unsigned char>(data[i - 1]);
    size_t expected;
    if (start < 0x80) expected = 1;
    else if ((start & 0xE0) == 0xC0) expected = 2;
    else if ((start & 0xF0) == 0xE0) expected = 3;
    else if ((start & 0xF8) == 0xF0) expected = 4;
    else return len; // malformed start byte; pass through
    size_t have = len - (i - 1);
    return have >= expected ? len : i - 1;
}

std::vector<llama_token> tokenize(const llama_vocab * vocab, const std::string & text, bool add_special) {
    int n = -llama_tokenize(vocab, text.c_str(), (int32_t) text.size(), nullptr, 0, add_special, true);
    if (n <= 0) return {};
    std::vector<llama_token> tokens(n);
    int written = llama_tokenize(vocab, text.c_str(), (int32_t) text.size(), tokens.data(), n, add_special, true);
    if (written < 0) return {};
    tokens.resize(written);
    return tokens;
}

std::string token_piece(const llama_vocab * vocab, llama_token token) {
    char buf[256];
    int n = llama_token_to_piece(vocab, token, buf, sizeof(buf), 0, true);
    if (n <= 0) return "";
    return std::string(buf, n);
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_faceclaw_app_FaceclawLlamaRunner_nativeLoadModel(
        JNIEnv * env, jclass, jstring jpath, jint n_ctx, jint n_threads) {
    ensure_backend_init();
    const std::string path = jstring_to_utf8(env, jpath);
    const int64_t t_start = now_ms();

    // Cap threads to the big-core count and pin them there (see
    // detect_fast_cpus): little cores would otherwise both drag the barrier
    // and invite the scheduler to keep us off the fast cores entirely.
    const std::vector<int> fast_cpus = detect_fast_cpus();
    int threads = (int) n_threads;
    if (!fast_cpus.empty()) {
        threads = std::min(threads, (int) fast_cpus.size());
    }

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = 0;
    llama_model * model = llama_model_load_from_file(path.c_str(), mparams);
    if (model == nullptr) {
        LOGW("model load failed: %s", path.c_str());
        return 0;
    }
    const int64_t t_model = now_ms();

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = (uint32_t) n_ctx;
    cparams.n_batch = 512;
    cparams.n_threads = threads;
    cparams.n_threads_batch = threads;
    llama_context * ctx = llama_init_from_model(model, cparams);
    if (ctx == nullptr) {
        LOGW("context init failed");
        llama_model_free(model);
        return 0;
    }

    ggml_threadpool * threadpool = nullptr;
    if (!fast_cpus.empty()) {
        ggml_threadpool_params tpp = ggml_threadpool_params_default(threads);
        for (size_t i = 0; i < fast_cpus.size() && fast_cpus[i] < GGML_MAX_N_THREADS; i++) {
            tpp.cpumask[fast_cpus[i]] = true;
        }
        tpp.strict_cpu = true;
        threadpool = ggml_threadpool_new(&tpp);
        if (threadpool != nullptr) {
            llama_attach_threadpool(ctx, threadpool, threadpool);
            std::string cpus;
            for (int cpu : fast_cpus) cpus += std::to_string(cpu) + " ";
            LOGI("pinned %d threads to fast cpus: %s", threads, cpus.c_str());
        } else {
            LOGW("threadpool creation failed; using default scheduling");
        }
    }

    auto * handle = new FcLlama();
    handle->model = model;
    handle->ctx = ctx;
    handle->threadpool = threadpool;
    handle->vocab = llama_model_get_vocab(model);
    handle->n_ctx = (int) llama_n_ctx(ctx);
    LOGI("model loaded: %s (n_ctx=%d, threads=%d, model_load_ms=%lld, ctx_init_ms=%lld)",
         path.c_str(), handle->n_ctx, threads,
         (long long) (t_model - t_start), (long long) (now_ms() - t_model));
    return reinterpret_cast<jlong>(handle);
}

extern "C" JNIEXPORT void JNICALL
Java_com_faceclaw_app_FaceclawLlamaRunner_nativeFree(JNIEnv *, jclass, jlong jhandle) {
    auto * handle = reinterpret_cast<FcLlama *>(jhandle);
    if (handle == nullptr) return;
    llama_free(handle->ctx);
    llama_model_free(handle->model);
    if (handle->threadpool != nullptr) {
        ggml_threadpool_free(handle->threadpool);
    }
    delete handle;
    LOGI("model freed");
}

extern "C" JNIEXPORT void JNICALL
Java_com_faceclaw_app_FaceclawLlamaRunner_nativeCancel(JNIEnv *, jclass, jlong jhandle) {
    auto * handle = reinterpret_cast<FcLlama *>(jhandle);
    if (handle != nullptr) handle->cancel.store(true);
}

extern "C" JNIEXPORT void JNICALL
Java_com_faceclaw_app_FaceclawLlamaRunner_nativeGenerate(
        JNIEnv * env, jclass, jlong jhandle, jstring jprompt, jstring jgrammar,
        jint max_tokens, jfloat temperature, jfloat top_p, jint top_k,
        jobject jlistener) {
    auto * handle = reinterpret_cast<FcLlama *>(jhandle);
    Listener listener = Listener::resolve(env, jlistener);
    if (handle == nullptr) {
        listener.error("Model is not loaded");
        return;
    }
    handle->cancel.store(false);

    const std::string prompt = jstring_to_utf8(env, jprompt);
    const std::string grammar = jstring_to_utf8(env, jgrammar);

    std::vector<llama_token> tokens = tokenize(handle->vocab, prompt, true);
    if (tokens.empty()) {
        listener.error("Prompt tokenization failed");
        return;
    }
    if ((int) tokens.size() + 16 > handle->n_ctx) {
        listener.error("Conversation too long for the on-phone model");
        return;
    }
    const int max_gen = std::min((int) max_tokens, handle->n_ctx - (int) tokens.size());

    // Reuse the KV prefix shared with the previous call; drop the rest. Keep
    // at least the final prompt token out of the reused prefix so this decode
    // produces logits for it.
    size_t common = 0;
    while (common < tokens.size() && common < handle->cache_tokens.size() &&
           tokens[common] == handle->cache_tokens[common]) {
        common++;
    }
    if (common == tokens.size()) common = tokens.size() - 1;
    llama_memory_seq_rm(llama_get_memory(handle->ctx), 0, (llama_pos) common, -1);
    handle->cache_tokens.assign(tokens.begin(), tokens.begin() + common);

    // Sampler chain per generation: Qwen3 instruct posture (temp 0.7, top-p
    // 0.8, top-k 20) plus an optional lazy grammar that activates at the
    // <tool_call> special token and forces a schema-valid call.
    llama_sampler * chain = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (!grammar.empty()) {
        llama_sampler * grammar_sampler = nullptr;
        std::vector<llama_token> trigger = tokenize(handle->vocab, "<tool_call>", false);
        if (trigger.size() == 1) {
            grammar_sampler = llama_sampler_init_grammar_lazy_patterns(
                handle->vocab, grammar.c_str(), "root", nullptr, 0, trigger.data(), 1);
        } else {
            static const char * patterns[] = {"(<tool_call>[\\s\\S]*)"};
            grammar_sampler = llama_sampler_init_grammar_lazy_patterns(
                handle->vocab, grammar.c_str(), "root", patterns, 1, nullptr, 0);
        }
        if (grammar_sampler != nullptr) {
            llama_sampler_chain_add(chain, grammar_sampler);
        } else {
            LOGW("tool grammar failed to parse; generating unconstrained");
        }
    }
    llama_sampler_chain_add(chain, llama_sampler_init_top_k(top_k));
    llama_sampler_chain_add(chain, llama_sampler_init_top_p(top_p, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(chain, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    const auto fail = [&](const std::string & message) {
        llama_sampler_free(chain);
        // The KV state past the reused prefix is now unknown; drop it so the
        // next call starts from a consistent cache.
        llama_memory_seq_rm(llama_get_memory(handle->ctx), 0, (llama_pos) handle->cache_tokens.size(), -1);
        listener.error(message);
    };

    // Prefill in n_batch chunks.
    const int64_t t_prefill_start = now_ms();
    const int n_batch = (int) llama_n_batch(handle->ctx);
    for (size_t i = common; i < tokens.size(); i += n_batch) {
        if (handle->cancel.load()) {
            llama_sampler_free(chain);
            listener.done("cancelled");
            return;
        }
        const int chunk = (int) std::min((size_t) n_batch, tokens.size() - i);
        if (llama_decode(handle->ctx, llama_batch_get_one(tokens.data() + i, chunk)) != 0) {
            fail("Prompt evaluation failed");
            return;
        }
        handle->cache_tokens.insert(handle->cache_tokens.end(), tokens.begin() + i, tokens.begin() + i + chunk);
    }

    // Decode loop: sample, stream, feed back.
    const int64_t t_decode_start = now_ms();
    const size_t n_prefilled = tokens.size() - common;
    int n_decoded = 0;
    std::string pending_utf8;
    const char * stop_reason = "length";
    for (int i = 0; i < max_gen; i++) {
        if (handle->cancel.load()) {
            stop_reason = "cancelled";
            break;
        }
        llama_token token = llama_sampler_sample(chain, handle->ctx, -1);
        if (llama_vocab_is_eog(handle->vocab, token)) {
            stop_reason = "stop";
            break;
        }
        pending_utf8 += token_piece(handle->vocab, token);
        size_t emit = utf8_complete_prefix(pending_utf8);
        if (emit > 0) {
            listener.token(pending_utf8.substr(0, emit));
            pending_utf8.erase(0, emit);
        }
        if (llama_decode(handle->ctx, llama_batch_get_one(&token, 1)) != 0) {
            fail("Token evaluation failed");
            return;
        }
        handle->cache_tokens.push_back(token);
        n_decoded++;
    }

    const int64_t t_end = now_ms();
    const int64_t prefill_ms = t_decode_start - t_prefill_start;
    const int64_t decode_ms = t_end - t_decode_start;
    LOGI("timing: prompt=%zu reused=%zu prefill=%zu tok in %lld ms (%.1f tok/s), decode=%d tok in %lld ms (%.1f tok/s)",
         tokens.size(), common, n_prefilled, (long long) prefill_ms,
         prefill_ms > 0 ? 1000.0 * (double) n_prefilled / (double) prefill_ms : 0.0,
         n_decoded, (long long) decode_ms,
         decode_ms > 0 ? 1000.0 * (double) n_decoded / (double) decode_ms : 0.0);

    if (!pending_utf8.empty()) {
        size_t emit = utf8_complete_prefix(pending_utf8);
        if (emit > 0) listener.token(pending_utf8.substr(0, emit));
    }
    llama_sampler_free(chain);
    listener.done(stop_reason);
}
