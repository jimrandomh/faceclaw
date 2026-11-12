declare const android: any;
declare const java: any;
declare const com: any;

const SAMPLE_RATE = 16000;

/**
 * Appends 16 kHz mono PCM16 to a WAV file in the public Downloads directory
 * while it is captured (Android; wav-recorder.ios.ts is the iOS one). The
 * native recorder keeps the header's sizes current, so a crash leaves a
 * playable file of everything up to the last second.
 */
export class WavRecorder {
  private constructor(private recorder: any, readonly path: string) {}

  /** A recorder for Downloads/<name>.wav (a -2, -3... suffix if taken), or null. */
  static open(name: string): WavRecorder | null {
    try {
      const downloads = android.os.Environment.getExternalStoragePublicDirectory(
        android.os.Environment.DIRECTORY_DOWNLOADS,
      );
      downloads.mkdirs();
      let file = new java.io.File(downloads, `${name}.wav`);
      for (let n = 2; file.exists(); n++) file = new java.io.File(downloads, `${name}-${n}.wav`);
      const path = String(file.getAbsolutePath());
      return new WavRecorder(new com.faceclaw.app.FaceclawWavRecorder(path, SAMPLE_RATE, 1), path);
    } catch (error) {
      console.warn(`WavRecorder: could not create ${name}.wav in Downloads: ${error}`);
      return null;
    }
  }

  /** `pcm` is the Java byte[] the voice controller delivered, passed back as it came. */
  append(pcm: any): void {
    this.recorder?.append(pcm);
  }

  close(): void {
    this.recorder?.finish();
    this.recorder = null;
  }
}
