import { type AppDefinition } from "../app-definition";
import { GlanceBoard } from "./board";
import { createGlanceboardAppWindow, GLANCEBOARD_SURFACE_ID, GLANCEBOARD_WINDOW_ID } from "./glanceboard-app";
import {
  glanceboardEnabledSetting,
  glanceDepth,
  glanceLayout,
  glanceShowOnHeadTiltSetting,
  glanceShowOnLongPressSetting,
  glanceShowOnTap,
  glanceTapTimeoutMs,
} from "./glanceboard-settings";

const glanceboardApp: AppDefinition = {
  appId: "glanceboard",
  title: "Glanceboard",
  icon: "eye",
  launch: (ctx) => ctx.launchInProcessApp(GLANCEBOARD_WINDOW_ID, GLANCEBOARD_SURFACE_ID, createGlanceboardAppWindow),
  glanceboard: {
    get size() {
      const layout = glanceLayout();
      return { width: layout.width, height: layout.height };
    },
    isEnabled: () => glanceboardEnabledSetting.get(),
    showOnTap: glanceShowOnTap,
    tapTimeoutMs: glanceTapTimeoutMs,
    showOnLongPress: () => glanceShowOnLongPressSetting.get(),
    showOnHeadTilt: () => glanceShowOnHeadTiltSetting.get(),
    depth: glanceDepth,
    createBoard: (requestRender) => new GlanceBoard(requestRender),
  },
};

export default glanceboardApp;
