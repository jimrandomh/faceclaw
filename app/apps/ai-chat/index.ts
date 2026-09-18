import type { AppDefinition } from "../app-definition";
import { createAiChatWindow } from "./ai-chat-app";

const aiChatApp: AppDefinition = {
  appId: "ai-chat",
  title: "AI Chat",
  icon: "message-circle",
  launch: (ctx) => ctx.launchInProcessApp("ai-chat", "window:ai-chat", createAiChatWindow),
};
export default aiChatApp;
