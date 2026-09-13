import { type AppDefinition } from "../app-definition";
import { GlanceBoard } from "./board";
import { createGlanceboardAppWindow, GLANCEBOARD_SURFACE_ID, GLANCEBOARD_WINDOW_ID } from "./glanceboard-app";
import {
  glanceboardEnabledSetting,
  glanceShowOnHeadTiltSetting,
  glanceShowOnLongPressSetting,
  glanceShowOnTap,
  glanceTapTimeoutMs,
} from "./glanceboard-settings";
import { QUADRANT_LAYOUT } from "./layout";

const glanceboardApp: AppDefinition = {
  appId: "glanceboard",
  title: "Glanceboard",
  icon: "eye",
  launch: (ctx) => ctx.launchInProcessApp(GLANCEBOARD_WINDOW_ID, GLANCEBOARD_SURFACE_ID, createGlanceboardAppWindow),
  glanceboard: {
    size: { width: QUADRANT_LAYOUT.width, height: QUADRANT_LAYOUT.height },
    isEnabled: () => glanceboardEnabledSetting.get(),
    showOnTap: glanceShowOnTap,
    tapTimeoutMs: glanceTapTimeoutMs,
    showOnLongPress: () => glanceShowOnLongPressSetting.get(),
    showOnHeadTilt: () => glanceShowOnHeadTiltSetting.get(),
    createBoard: (requestRender) => new GlanceBoard(requestRender, QUADRANT_LAYOUT),
  },
};

export default glanceboardApp;
