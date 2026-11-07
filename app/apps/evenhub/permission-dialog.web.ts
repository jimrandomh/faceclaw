import type { GrayImage } from "../../graphics/image";
import type { Layer } from "../../ui/layers";

/** Never constructed: the browser demo's readEvenHubPackageManifest finds no package to ask about. */
export const EvenHubPermissionDialogLayer: new (...args: unknown[]) => Layer = class implements Layer {
  paint(): GrayImage { throw new Error("EvenHub apps can't run in the browser demo"); }
  async handleInput(): Promise<void> {}
};
