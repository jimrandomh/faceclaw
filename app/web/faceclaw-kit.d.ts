/** The shared Kotlin, compiled for the browser (native/kotlin/shared/src/jsMain/.../WebNativeApi.kt). */
declare module "faceclaw-kit" {
  export class WebSurfaceCompositor {
    constructor(width: number, height: number);
    configure(id: string, x: number, y: number, width: number, height: number, zOrder: number, transparent: boolean): void;
    remove(id: string): void;
    hasSurface(id: string): boolean;
    visible(id: string, visible: boolean): void;
    depth(id: string, depth: number): void;
    dim(below: number, factor: number): void;
    blank(blanked: boolean): void;
    shell(data: Int8Array): void;
    submit(id: string, data: Int8Array, x: number, y: number, width: number, height: number, draws: Int8Array | null): void;
    composite(): Int8Array;
    setPreviewAnimationListener(listener: (() => void) | null): void;
  }
  export const WebTextureAtlas: {
    getInstance(): {
      assignFontId(key: string, id: number): void;
      registerGlyphs(data: Int8Array): void;
      registerAaGlyphs(data: Int8Array): void;
      registerFirmwareGlyphs(data: Int8Array): void;
      registerImage(key: string, id: number, width: number, height: number, pixels: Int8Array): void;
    };
  };
  export const WebProtocol: {
    getInstance(): {
      fontMetrics(path: string): Int8Array;
      fontGlyph(path: string, codePoint: number): Int8Array;
    };
  };
}
