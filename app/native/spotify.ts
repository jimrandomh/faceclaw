import { Application, Utils } from "@nativescript/core";
import { fetchTextWithUserAgent } from "../util/http";
import { downloadBinary } from "./binary-http";
import { grayImageFromPacket, PHOTO_TONE } from "./image-files";
import { copyToJavaByteBuffer } from "./java-direct-buffer";
import type { WebSignIn } from "./spotify-auth";
import { SPOTIFY_ANDROID_PACKAGE } from "./spotify-player";
import { SpotifyService } from "./spotify-service";

declare const android: any;
declare const com: any;

const ART_DOWNLOAD_TIMEOUT_MS = 10_000;

/** The sign-in's listener proxy, held while Java may still call it. */
let signInListener: unknown = null;

/** Faceclaw's activity is in front, so it may open the browser (Android blocks background activity starts). */
function foregroundActivity(): any {
  return Application.suspended ? null : Application.android?.foregroundActivity ?? null;
}

/**
 * Sign-in in the phone's browser, with FaceclawWebSignIn catching the
 * loopback redirect. A sign-in started from the glasses while Faceclaw is in
 * the background opens the page when Faceclaw next comes to the front, as on
 * iOS.
 */
const webSignIn: WebSignIn = {
  createPkce: () => {
    // 64 URL-safe characters (RFC 7636 allows 43..128).
    const verifier = String(com.faceclaw.app.FaceclawWebSignIn.randomBase64Url(48));
    return { verifier, challenge: String(com.faceclaw.app.FaceclawWebSignIn.sha256Base64Url(verifier)) };
  },
  randomState: () => String(com.faceclaw.app.FaceclawWebSignIn.randomBase64Url(16)),
  open: (authorizeUrl, port, path) =>
    new Promise<string>((resolve, reject) => {
      const native = com.faceclaw.app.FaceclawWebSignIn.shared();
      let onResume: ((args: any) => void) | null = null;
      const stopWaiting = () => {
        if (onResume) Application.off(Application.resumeEvent, onResume);
        onResume = null;
      };
      const listener = new com.faceclaw.app.FaceclawWebSignInListener({
        onFinished: (redirectUrl: string | null, error: string | null) => {
          if (signInListener === listener) signInListener = null;
          stopWaiting();
          if (redirectUrl) resolve(String(redirectUrl));
          else reject(new Error(String(error || "Sign-in failed")));
        },
      });
      const startError = native.start(port, path, listener);
      if (startError) {
        reject(new Error(String(startError)));
        return;
      }
      signInListener = listener;
      const present = (activity: any) => {
        stopWaiting();
        const openError = native.openBrowser(activity, authorizeUrl);
        if (openError) native.fail(String(openError));
      };
      const activity = foregroundActivity();
      if (activity) {
        present(activity);
        return;
      }
      onResume = (args: any) => present(args?.activity ?? args?.android ?? Utils.android.getApplicationContext());
      Application.on(Application.resumeEvent, onResume);
    }),
  cancel: () => com.faceclaw.app.FaceclawWebSignIn.shared().cancel(),
};

/** The phone's media-stream volume, for Spotify playing on this phone (as the session bridge reports it). */
function audioManager(): any {
  return Utils.android.getApplicationContext()?.getSystemService(android.content.Context.AUDIO_SERVICE) ?? null;
}

const systemVolume = {
  get: (): number => {
    const audio = audioManager();
    if (!audio) return -1;
    const max = Number(audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC));
    if (max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((Number(audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC)) * 100) / max)));
  },
  set: (percent: number): void => {
    const audio = audioManager();
    if (!audio) return;
    const max = Number(audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC));
    const volume = Math.round((Math.max(0, Math.min(100, percent)) * max) / 100);
    audio.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, volume, 0);
  },
};

let service: SpotifyService | null = null;

/**
 * The Spotify Web API service, created on first use (main thread only: it
 * owns timers and the sign-in). Signing in is optional on Android: Spotify's
 * media session already gives now-playing and transport control, and the
 * media bridges add the Web API's extras once signed in (library browsing,
 * search, shuffle / repeat / like, playback on other Spotify devices).
 */
export function spotifyService(): SpotifyService | null {
  service ??= new SpotifyService({
    packageName: SPOTIFY_ANDROID_PACKAGE,
    fetch: (url, init) => fetchTextWithUserAgent(url, init),
    webSignIn,
    download: async (url) => {
      const response = await downloadBinary(url, ART_DOWNLOAD_TIMEOUT_MS);
      return response.status === 200 ? response.bytes : null;
    },
    decodeArt: (bytes, maxSize) => {
      const size = Math.round(maxSize);
      // The shared photo tone (gamma + dither), as for media-session art.
      return grayImageFromPacket(
        com.faceclaw.app.ImageFileLoader.loadGrayFromBytes(copyToJavaByteBuffer(bytes), size, size, PHOTO_TONE.gamma, PHOTO_TONE.dither),
      );
    },
    systemVolume,
  });
  return service;
}
