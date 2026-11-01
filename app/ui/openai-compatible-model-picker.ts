import { MenuLayer, type MenuItem } from "./menu";
import { EditTextSettingLayer } from "./dashboard-settings";
import type { LayerContext } from "./layers";
import {
  discoverOpenAiCompatibleModels,
  type DiscoveredCompatibleModel,
} from "../native/openai-chat-models";

export type ModelDiscoverySettings = {
  getBaseUrl(): string;
  getApiKey(): string;
  getModel(): string;
  setModel(model: string): void;
};

type Discover = typeof discoverOpenAiCompatibleModels;
type PickerState = "loading" | "models" | "error";

const DISCOVERY_EXPLANATION =
  "Discover models queries only this server's /models endpoint. Choose an exact model ID, or keep using manual entry. This does not send an inference request.";

/** A cancellable, on-demand model picker embedded in Faceclaw's existing menus. */
export class OpenAiCompatibleModelPicker extends MenuLayer {
  private state: PickerState = "loading";
  private models: DiscoveredCompatibleModel[] = [];
  private error = "";
  private showOffline = false;
  private requestGeneration = 0;
  private endpointKey = "";
  private removed = false;
  private readonly modelIdByRow = new Map<MenuItem, string>();

  constructor(
    private readonly settings: ModelDiscoverySettings,
    private readonly modelSetting: ConstructorParameters<typeof EditTextSettingLayer>[0],
    private readonly discover: Discover = discoverOpenAiCompatibleModels,
    viewport: { width: number; height: number } = { width: 640, height: 480 },
  ) {
    super("Discover models", [], discoveryLayout(viewport));
  }

  open(ctx: LayerContext): void {
    ctx.stack.push(this);
    void this.refresh(ctx);
  }

  private currentEndpoint(): string {
    return `${this.settings.getBaseUrl().trim()}\n${this.settings.getApiKey().trim()}`;
  }

  private async refresh(ctx: LayerContext, forceRefresh = false): Promise<void> {
    const generation = ++this.requestGeneration;
    const endpointKey = this.currentEndpoint();
    this.endpointKey = endpointKey;
    this.state = "loading";
    this.error = "";
    this.updateRows();
    try {
      const models = await this.discover({
        baseUrl: this.settings.getBaseUrl(),
        apiKey: this.settings.getApiKey(),
        forceRefresh,
      });
      if (!this.isActive(generation)) return;
      if (endpointKey !== this.currentEndpoint()) {
        this.error = "API URL or key changed; discover again";
        this.state = "error";
      } else {
        this.models = models;
        this.state = "models";
      }
    } catch (error) {
      if (!this.isActive(generation)) return;
      this.error = endpointKey !== this.currentEndpoint()
        ? "API URL or key changed; discover again"
        : error instanceof Error ? error.message : String(error);
      this.state = "error";
    }
    this.updateRows();
    ctx.actions.requestRender();
  }

  private isActive(generation: number): boolean {
    // A temporary overlay may sit above this still-open picker. Removal, not
    // top-of-stack status, determines whether the pending result is obsolete.
    return !this.removed && generation === this.requestGeneration;
  }

  private updateRows(): void {
    this.modelIdByRow.clear();
    const rows: MenuItem[] = [];
    if (this.state === "loading") {
      rows.push({ label: "Discovering models...", disabled: true, description: DISCOVERY_EXPLANATION, onSelect: () => {} });
      rows.push({
        label: "Cancel discovery",
        description: "Ignore the pending result and return to Assistant settings.",
        onSelect: (innerCtx) => innerCtx.stack.pop(),
      });
    } else if (this.state === "error") {
      rows.push({
        label: `Failed: ${truncateModelLabel(this.error || "Discovery failed", 40)}`,
        disabled: true,
        description: `${this.error}. Manual model entry is still available.`,
        onSelect: () => {},
      });
      rows.push({
        label: "Try again",
        description: "Query this server's /models endpoint again without changing the saved model.",
        onSelect: (innerCtx) => { void this.refresh(innerCtx, true); },
      });
    } else {
      const saved = this.settings.getModel().trim();
      const listed = this.models.filter((model) => this.showOffline || !model.offline || model.id === saved);
      const savedModel = saved ? this.models.find((model) => model.id === saved) : undefined;
      if (saved && !savedModel) {
        rows.push(this.modelRow({
          id: saved, name: saved, supportsTools: null, offline: false, deprecated: false, beta: false,
        }, "saved; not listed"));
      }
      if (!listed.length) {
        rows.push({
          label: this.models.length ? "No online models listed" : "No models listed",
          disabled: true,
          description: "Keep the saved model or use manual entry.",
          onSelect: () => {},
        });
      } else {
        rows.push(...listed.map((model) => this.modelRow(model)));
      }
      if (this.models.some((model) => model.offline)) {
        rows.push({
          label: this.showOffline ? "Hide offline models" : `Show offline (${this.models.filter((model) => model.offline).length})`,
          description: "Offline models normally fail inference until the provider restores them.",
          onSelect: (innerCtx) => {
            this.showOffline = !this.showOffline;
            this.updateRows();
            innerCtx.actions.requestRender();
          },
        });
      }
      rows.push({
        label: "Refresh models",
        description: "Fetch a fresh catalog. This never changes the selected model by itself.",
        onSelect: (innerCtx) => { void this.refresh(innerCtx, true); },
      });
    }
    rows.push({
      label: "Enter model manually",
      description: "Use an exact model ID when discovery is unavailable or the desired model is not listed.",
      onSelect: (innerCtx) => {
        this.requestGeneration++; // Any late discovery result belongs to the closed picker.
        void innerCtx.actions.startTextSettingEdit(this.modelSetting);
        innerCtx.stack.popThrough(this);
        innerCtx.stack.push(new EditTextSettingLayer(this.modelSetting));
      },
    });
    const current = this.settings.getModel().trim();
    const selected = Math.max(0, rows.findIndex((row) => this.modelIdByRow.get(row) === current));
    this.setItems(rows, selected);
  }

  private modelRow(model: DiscoveredCompatibleModel, extraLabel?: string): MenuItem {
    const flags: string[] = [];
    if (model.supportsTools === true) flags.push("tools");
    else if (model.supportsTools === false) flags.push("no tools");
    else flags.push("tools unknown");
    if (model.offline) flags.push("offline");
    if (model.deprecated) flags.push("deprecated");
    if (model.beta) flags.push("beta");
    if (extraLabel) flags.push(extraLabel);
    const selected = this.settings.getModel().trim() === model.id ? " *" : "";
    const displayName = model.name === model.id ? model.id : `${model.name} (${model.id})`;
    const toolFlag = model.supportsTools === true ? "tools" : model.supportsTools === false ? "no tools" : "tools?";
    const visibleFlags = [toolFlag];
    if (model.offline) visibleFlags.push("offline");
    if (model.deprecated) visibleFlags.push("old");
    if (model.beta) visibleFlags.push("beta");
    if (extraLabel) visibleFlags.push("saved only");
    const flagSuffix = ` [${visibleFlags.join("/")}]`;
    const row: MenuItem = {
      label: `${truncateModelLabel(displayName, Math.max(12, 44 - flagSuffix.length))}${flagSuffix}${selected}`,
      description: `${model.name}: ${model.id} — ${flags.join(", ")}. Tool support unknown means the server did not advertise it; test before relying on glasses actions.`,
      onSelect: (innerCtx) => {
        // Re-read immediately before saving; a late catalog never overwrites a
        // selection made against a different endpoint.
        if (this.settings.getBaseUrl().trim() + "\n" + this.settings.getApiKey().trim() !== this.endpointKey) return;
        this.settings.setModel(model.id);
        innerCtx.stack.popThrough(this);
      },
    };
    this.modelIdByRow.set(row, model.id);
    return row;
  }

  onRemoved(): void {
    this.removed = true;
    this.requestGeneration++; // Invalidate the pending result immediately.
  }
}

/** Kept separate so tests can verify the normal Faceclaw modal sizing contract. */
function discoveryLayout(viewport: { width: number; height: number }): ConstructorParameters<typeof MenuLayer>[2] {
  return {
    x: "center",
    y: 8,
    width: Math.min(320, viewport.width - 40),
    minHeight: Math.min(160, viewport.height - 40),
    maxHeight: Math.min(240, viewport.height - 40),
    depth: 4,
  };
}

function truncateModelLabel(value: string, maxLength = 44): string {
  if (value.length <= maxLength) return value;
  const tailLength = Math.min(19, Math.max(4, maxLength - 8));
  const headLength = Math.max(1, maxLength - tailLength - 3);
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

/** One stable Assistant settings row; discovery state belongs to the pushed picker. */
export function compatibleModelDiscoveryMenuItem(
  settings: ModelDiscoverySettings,
  modelSetting: ConstructorParameters<typeof EditTextSettingLayer>[0],
  discover: Discover = discoverOpenAiCompatibleModels,
): MenuItem {
  return {
    label: "Discover models",
    description: DISCOVERY_EXPLANATION,
    disabled: () => !settings.getBaseUrl().trim(),
    onSelect: (ctx) => new OpenAiCompatibleModelPicker(settings, modelSetting, discover, ctx.stack.getBaseSize()).open(ctx),
  };
}
