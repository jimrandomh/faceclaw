import { type AppDefinition } from "../app-definition";
import { createWeatherAppWindow, WEATHER_SURFACE_ID, WEATHER_WINDOW_ID } from "./weather-app";
import { startWeatherIndicators } from "./weather-indicators";

const weatherApp: AppDefinition = {
  appId: "weather",
  title: "Weather",
  icon: "cloud-sun",
  boot: () => startWeatherIndicators(),
  launch: (ctx) => ctx.launchInProcessApp(WEATHER_WINDOW_ID, WEATHER_SURFACE_ID, createWeatherAppWindow),
};

export default weatherApp;
