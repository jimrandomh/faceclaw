import { ensureLocationPermission, hasLocationPermission } from "../../native/location-permissions";
import { weatherBridge } from "../../native/weather";
import { toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { WeatherLayer } from "./weather";
import { weatherShowInStatusBarSetting, weatherShowOnSystemCardSetting } from "./weather-settings";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

export const WEATHER_WINDOW_ID = "weather";
export const WEATHER_SURFACE_ID = "window:weather";

/** Local current conditions and forecast from the National Weather Service. */
export function createWeatherAppWindow(options: InProcessAppOptions): InProcessWindow {
  let closed = false;
  let requestingPermission = false;
  let unsubscribe: (() => void) | null = null;

  const requestUpdate = () => {
    if (closed || requestingPermission) return;
    if (hasLocationPermission()) {
      weatherBridge.start();
      return;
    }
    requestingPermission = true;
    void ensureLocationPermission().then((granted) => {
      requestingPermission = false;
      if (closed) return;
      if (granted) weatherBridge.start();
      app.requestRender();
    }).catch((error) => { requestingPermission = false; console.warn(`Weather permission: ${error}`); });
  };

  // An indicator switched on without location access asks for it here, since
  // its background refreshes have no screen of their own to prompt from.
  const indicatorSettingOptions = {
    onChange: (_ctx: unknown, enabled: boolean) => {
      if (enabled && !hasLocationPermission()) requestUpdate();
    },
  };

  const app = createInProcessWindow({
    appId: "weather",
    windowId: WEATHER_WINDOW_ID,
    title: "Weather",
    iconLetter: "W",
    icon: "cloud-sun",
    closeable: true,
    menuItems: () => [
      {
        label: "Refresh",
        onSelect: (ctx) => {
          ctx.stack.pop();
          requestUpdate();
        },
      },
      {
        label: "Settings",
        onSelect: (ctx) => {
          // Pop the menu first so closing the settings modal lands back on
          // the forecast, not this menu.
          ctx.stack.pop();
          openSettingsSubMenu(ctx, "Weather settings", [
            toggleSettingMenuItem(weatherShowInStatusBarSetting, indicatorSettingOptions),
            toggleSettingMenuItem(weatherShowOnSystemCardSetting, indicatorSettingOptions),
          ]);
        },
      },
    ],
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new WeatherLayer(() => weatherBridge.snapshot(), requestUpdate)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: () => {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      weatherBridge.stop();
      options.onClosed();
    },
  });
  unsubscribe = weatherBridge.onStateChange(() => app.requestRender());
  requestUpdate();
  return app;
}
