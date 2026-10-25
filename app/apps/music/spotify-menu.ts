import type { GrayImage } from "../../graphics/image";
import { isValidSpotifyClientId, SPOTIFY_DASHBOARD_URL, SPOTIFY_REDIRECT_URI } from "../../native/spotify-auth";
import type { SpotifyService } from "../../native/spotify-service";
import { spotifyClientIdSetting, textSettingMenuItem } from "../../ui/dashboard-settings";
import { type InputEvent } from "../../ui/gestures";
import { type LayerContext, type PaintBelow } from "../../ui/layers";
import { submenuItem, TextPageLayer, type MenuItem } from "../../ui/menu";
import { WindowMenuLayer } from "../../ui/window-menu";
import { TextViewerLayer } from "../files/text-viewer";

const SETUP_HELP = [
  "Faceclaw controls Spotify through Spotify's Web API, which needs a Spotify developer app of your own. Creating one is free; Spotify requires its owner to have Premium, and controlling playback needs Premium too.",
  "",
  `1. On a computer, open ${SPOTIFY_DASHBOARD_URL.replace("https://", "")} and sign in with your Spotify account.`,
  "2. Create an app. Any name and description will do.",
  `3. Add this Redirect URI exactly: ${SPOTIFY_REDIRECT_URI}`,
  "4. Under \"Which API/SDKs are you planning to use?\", tick Web API, then save.",
  "5. Open the app's settings, copy its Client ID, and enter it as Client ID here.",
  "6. Choose Sign in, then finish on your phone: Faceclaw opens Spotify's sign-in page there.",
  "",
  "Spotify plays on whichever of your devices is open (this phone, a computer, a speaker). To start music when nothing is playing, Spotify must be open on one of them.",
  "",
  "Others can sign in with your client ID once you add their Spotify email under User Management in the dashboard (up to five people).",
].join("\n");

/** The Music app menu's Spotify row (iOS): sign in, sign out, client ID, setup help. */
export function spotifyMenuItem(service: SpotifyService): MenuItem {
  return submenuItem("Spotify", (ctx) => ctx.stack.push(new SpotifyMenuLayer(service)), {
    description: "Sign in to Spotify to show and control it from the glasses.",
  });
}

/**
 * Rows rebuilt every paint and input from the account and sign-in progress,
 * which change asynchronously. A WindowMenuLayer, so the shell's system menu
 * closes it like the window menu it opens from.
 */
class SpotifyMenuLayer extends WindowMenuLayer {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly service: SpotifyService) {
    super("Spotify", []);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    this.unsubscribe ??= this.service.onChange(() => ctx.actions.requestRender());
    this.setItems(this.rows());
    return super.paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    this.setItems(this.rows());
    await super.handleInput(event, ctx);
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private rows(): MenuItem[] {
    const service = this.service;
    const account = service.account();
    const status = service.signInStatus();
    const help: MenuItem = {
      label: "Setup help",
      onSelect: (ctx) => ctx.stack.push(new TextViewerLayer(SETUP_HELP, "Spotify setup")),
    };
    if (account) {
      return [
        info(`Signed in as ${account.displayName || account.userId}`),
        ...(account.product && account.product !== "premium" ? [info("Playback control needs Premium")] : []),
        { label: "Sign out", onSelect: () => service.signOut() },
        textSettingMenuItem(spotifyClientIdSetting),
        help,
      ];
    }
    if (status.phase === "waiting") {
      return [
        info("Finish signing in on the phone"),
        { label: "Cancel sign-in", onSelect: () => service.cancelSignIn() },
        help,
      ];
    }
    const failure: MenuItem[] = status.error
      ? [{
          label: "Sign-in failed (details)",
          onSelect: (ctx) => ctx.stack.push(new TextPageLayer("Spotify sign-in failed", status.error)),
        }]
      : [];
    return [
      {
        label: "Sign in",
        description: "Opens Spotify's sign-in page on the phone.",
        disabled: () => !isValidSpotifyClientId(spotifyClientIdSetting.get()),
        onSelect: () => void service.signIn(),
      },
      textSettingMenuItem(spotifyClientIdSetting),
      help,
      ...failure,
    ];
  }
}

function info(label: string): MenuItem {
  return { label, disabled: true, onSelect: () => {} };
}
