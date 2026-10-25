import { fetchTextWithUserAgent } from "../util/http";
import { downloadBinary } from "./binary-http.ios";
import { grayImageFromPacket, PHOTO_TONE } from "./image-files";
import { fromData, toData } from "./kotlin-data";
import type { WebSignIn } from "./spotify-auth";
import { SpotifyService } from "./spotify-service";

declare const FaceclawAppleMusic: any;
declare const FaceclawCrypto: any;
declare const FaceclawGraphics: any;
declare const FaceclawKitIosProtocol: any;
declare const FaceclawWebSignIn: any;

const ART_DOWNLOAD_TIMEOUT_MS = 10_000;

/** Sign-in in the system browser sheet, which FaceclawWebSignIn closes once the loopback redirect arrives. */
const webSignIn: WebSignIn = {
  createPkce: () => {
    // 64 URL-safe characters (RFC 7636 allows 43..128).
    const verifier = String(FaceclawCrypto.randomBase64Url(48));
    return { verifier, challenge: String(FaceclawCrypto.sha256Base64Url(verifier)) };
  },
  randomState: () => String(FaceclawCrypto.randomBase64Url(16)),
  open: (authorizeUrl, port, path) =>
    new Promise<string>((resolve, reject) => {
      FaceclawWebSignIn.shared().signInPortPathCompletion(authorizeUrl, port, path, (redirectUrl: string | null, error: string | null) => {
        if (redirectUrl) resolve(String(redirectUrl));
        else reject(new Error(String(error || "Sign-in failed")));
      });
    }),
  cancel: () => FaceclawWebSignIn.shared().cancel(),
};

let protocol: any = null;
let service: SpotifyService | null = null;

/** The Spotify service, created on first use (main thread only: it owns timers and the sign-in sheet). */
export function spotifyService(): SpotifyService | null {
  service ??= new SpotifyService({
    fetch: (url, init) => fetchTextWithUserAgent(url, init),
    webSignIn,
    download: async (url) => {
      const response = await downloadBinary(url, ART_DOWNLOAD_TIMEOUT_MS);
      return response.status === 200 ? response.bytes : null;
    },
    decodeArt: (bytes, maxSize) => {
      const packet = FaceclawGraphics.bgraPacketFromImageDataMaxSize(toData(bytes), Math.round(maxSize));
      if (!packet) return null;
      // The shared Kotlin tone curve and dither, as for Apple Music's art.
      protocol ??= FaceclawKitIosProtocol.new();
      return grayImageFromPacket(fromData(protocol.grayPacketBgraGammaDither(packet, PHOTO_TONE.gamma, PHOTO_TONE.dither)));
    },
    // FaceclawAppleMusic's system output volume needs no media-library access.
    systemVolume: {
      get: () => {
        const volume = Number(FaceclawAppleMusic.shared().volumePercent());
        return Number.isFinite(volume) ? Math.max(-1, Math.min(100, Math.round(volume))) : -1;
      },
      set: (percent) => FaceclawAppleMusic.shared().setVolumePercent(Math.max(0, Math.min(100, Math.round(percent)))),
    },
  });
  return service;
}
