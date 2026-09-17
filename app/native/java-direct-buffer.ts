/**
 * Hands bytes to a Java `java.nio.ByteBuffer` parameter without leaking them.
 *
 * Why this exists: NativeScript Android (9.0.4 through at least 9.1.1)
 * converts a JS ArrayBuffer or typed array passed to a Java method by wrapping
 * its backing store in `NewDirectByteBuffer` and taking a JNI global ref that is
 * never deleted (JsArgConverter.cpp, `buffer = env.NewGlobalRef(buffer)`). The
 * ByteBuffer is also linked to the JS ArrayBuffer as its native counterpart.
 * The leaked global ref keeps the ByteBuffer reachable forever, so the
 * runtime's GC handshake (Runtime.makeInstanceWeakAndCheckIfAlive) always says
 * "alive", the JS finalizer re-arms, and V8 never frees the ArrayBuffer. Every
 * call leaked its whole buffer plus one global ref.
 *
 * On the frame path that meant a full surface (576x260, 640x452 or 640x480
 * bytes) per submitted frame, including frames the Java side then discards as
 * unchanged. Measured on a Galaxy Z Fold7, native-heap growth matched frame
 * bytes submitted to within a few percent, and Samsung's Heimdall memory
 * manager killed the app at about 6.4 GB. ART also aborts the process once
 * 51,200 global refs are held, so the ref leak is a second ceiling behind the
 * memory one.
 *
 * The workaround keeps the conversion out of the call: the bytes are copied
 * into a Java-allocated direct ByteBuffer that is reused, through an
 * ArrayBuffer view made once with `ArrayBuffer.from` (an external backing
 * store over the Java memory, no global ref), and the Java ByteBuffer object
 * itself is passed. A JS proxy for an existing Java object takes the ordinary
 * object path, which does not leak.
 *
 * Contract: the buffer returned by load() is only valid until the next load()
 * on the same instance, so the Java callee must consume it synchronously and
 * not keep a reference. The Kotlin consumers (SurfaceCompositor via
 * AndroidByteReader, playBuzzerSequence, ShellScene.decode) copy or parse
 * before returning, which satisfies this. One instance belongs to one JS
 * context (main thread or one worker); instances are not shared across
 * isolates.
 */

declare const java: any;

/** Minimal surface of java.nio.ByteBuffer this module uses. */
export interface JavaByteBufferLike {
  clear(): unknown;
  limit(newLimit: number): unknown;
}

/** How to allocate a direct buffer and view its memory; injectable for tests. */
export interface DirectBufferBackend {
  allocateDirect(capacity: number): JavaByteBufferLike;
  viewOf(buffer: JavaByteBufferLike): Uint8Array;
}

const nativeScriptBackend: DirectBufferBackend = {
  allocateDirect: (capacity) => java.nio.ByteBuffer.allocateDirect(capacity),
  viewOf: (buffer) => new Uint8Array((ArrayBuffer as any).from(buffer)),
};

/** Capacity grows in steps of this many bytes, so a slowly growing payload does not reallocate every call. */
const CAPACITY_STEP_BYTES = 4096;

export class JavaDirectBuffer {
  private javaBuffer: JavaByteBufferLike | null = null;
  private view: Uint8Array | null = null;
  /** Number of Java buffers allocated so far (a test and diagnostics hook). */
  allocations = 0;

  constructor(
    private readonly initialCapacity = 0,
    private readonly backend: DirectBufferBackend = nativeScriptBackend,
  ) {}

  /**
   * Copy `bytes` into the reused Java buffer and return it with position 0 and
   * limit `bytes.length`, so `remaining()` equals the byte count. Valid until
   * the next load() on this instance.
   */
  load(bytes: Uint8Array): JavaByteBufferLike {
    if (!this.javaBuffer || !this.view || this.view.length < bytes.length) {
      const wanted = Math.max(bytes.length, this.initialCapacity, 1);
      const capacity = Math.ceil(wanted / CAPACITY_STEP_BYTES) * CAPACITY_STEP_BYTES;
      this.javaBuffer = this.backend.allocateDirect(capacity);
      this.view = this.backend.viewOf(this.javaBuffer);
      this.allocations++;
    }
    this.view.set(bytes);
    this.javaBuffer.clear();
    this.javaBuffer.limit(bytes.length);
    return this.javaBuffer;
  }

  /** As load(), for an optional ArrayBuffer (e.g. a frame's draw list); null stays null. */
  loadOptional(buffer: ArrayBuffer | null | undefined): JavaByteBufferLike | null {
    if (!buffer || buffer.byteLength === 0) return null;
    return this.load(new Uint8Array(buffer));
  }
}
