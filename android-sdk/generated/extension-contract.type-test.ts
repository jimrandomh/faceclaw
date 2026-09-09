// Generated type contract checks; expected errors prove feature/config discrimination.
import type { ExtensionDeclaration } from "./extension-contract";

const valid: ExtensionDeclaration = {
  feature: "ui.navigation",
  enabled: true,
  configuration: { doubleTap: "sleep" },
};
void valid;

const invalidNavigation: ExtensionDeclaration = {
  feature: "ui.navigation",
  enabled: true,
  configuration: {
    // @ts-expect-error ui.navigation does not accept typography.size
    size: 17,
  },
};
void invalidNavigation;

const invalidTypography: ExtensionDeclaration = {
  feature: "ui.typography",
  enabled: true,
  configuration: {
    // @ts-expect-error ui.typography does not accept navigation.doubleTap
    doubleTap: "sleep",
  },
};
void invalidTypography;
