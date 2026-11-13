declare const android: any;
declare const java: any;

/** Extension of the recordings Save Recording writes, and Transcribe replays (Matroska audio). */
export const RECORDING_EXTENSION = ".mka";

export function isMicRecordingFile(name: string): boolean {
  return name.toLowerCase().endsWith(RECORDING_EXTENSION);
}

/**
 * The path for a new recording in the public Downloads directory:
 * Downloads/<name>.mka, with a -2, -3... suffix if that is taken. Null when
 * Downloads isn't available. The file itself is created by whoever records.
 */
export function newRecordingPath(name: string): string | null {
  try {
    const downloads = android.os.Environment.getExternalStoragePublicDirectory(
      android.os.Environment.DIRECTORY_DOWNLOADS,
    );
    downloads.mkdirs();
    let file = new java.io.File(downloads, `${name}${RECORDING_EXTENSION}`);
    for (let n = 2; file.exists(); n++) file = new java.io.File(downloads, `${name}-${n}${RECORDING_EXTENSION}`);
    return String(file.getAbsolutePath());
  } catch (error) {
    console.warn(`Voice: no Downloads directory for ${name}${RECORDING_EXTENSION}: ${error}`);
    return null;
  }
}
