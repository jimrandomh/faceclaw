import { type AppDefinition } from "../app-definition";
import {
  CALCULATOR_SURFACE_ID,
  CALCULATOR_WINDOW_ID,
  createCalculatorAppWindow,
} from "./calculator-app";

/**
 * A spoken (or typed) problem in, an exact answer on the lens — with
 * step-by-step explanations, graphs, and the advanced spoken-question
 * topics (primality, integrals, digit searches in π, geometry).
 */
const calculatorApp: AppDefinition = {
  appId: "calculator",
  title: "Calculator",
  icon: "calculator",
  launch: (ctx) => ctx.launchInProcessApp(CALCULATOR_WINDOW_ID, CALCULATOR_SURFACE_ID, createCalculatorAppWindow),
};

export default calculatorApp;
