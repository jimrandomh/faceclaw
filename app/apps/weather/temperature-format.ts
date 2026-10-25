import { temperatureUnitSetting } from "../../ui/dashboard-settings";

/**
 * A temperature (weather data is kept in Fahrenheit) in the unit chosen in
 * Settings > Customization > Temperature unit, rounded: "72°F" / "22°C", or
 * "72°" without the unit letter.
 */
export function formatTemperature(fahrenheit: number, withUnit = true): string {
  const celsius = temperatureUnitSetting.get() === "celsius";
  const value = Math.round(celsius ? (fahrenheit - 32) * 5 / 9 : fahrenheit);
  return withUnit ? `${value}°${celsius ? "C" : "F"}` : `${value}°`;
}

/** The widest temperature the forecast's column is sized for. */
export function widestTemperatureSample(): string {
  return temperatureUnitSetting.get() === "celsius" ? "-20°C" : "100°F";
}
