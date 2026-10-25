import type { SpotifyService } from "./spotify-service";

/**
 * Spotify through its Web API is wired up on iOS only (spotify.ios.ts): on
 * Android, Spotify publishes a media session the Music app already controls.
 */
export function spotifyService(): SpotifyService | null {
  return null;
}
