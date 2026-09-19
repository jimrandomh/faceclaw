/**
 * EvenHub app permissions: parsing the manifest's declared permissions and
 * turning them into the human-readable list Faceclaw shows for confirmation.
 *
 * Two manifest shapes exist in the wild (see notes/evenhub_compatibility.txt):
 *  - Current SDK: `permissions` is an array of {name, desc?, whitelist?}, with
 *    names network, location, g2-microphone, phone-microphone, album, camera.
 *  - Older shape: `permissions` is a map {"network": [...hosts], "fs": [...]}.
 *
 * Permissions are confirmed by the user when an app is installed, or when an
 * uninstalled .ehpk is run directly (installing implies a prior confirmation).
 * Once past that gate the running app is treated as having been granted every
 * permission it declared; runtime surfaces (e.g. the microphone) check the
 * declared set to decide whether to honor a request.
 */

export type EvenHubPermissionName =
  | "network"
  | "location"
  | "g2-microphone"
  | "phone-microphone"
  | "album"
  | "camera"
  | "fs"
  | string;

export type EvenHubPermission = {
  name: EvenHubPermissionName;
  /** App-supplied description, when the manifest provides one. */
  description?: string;
  /** For network/fs: the declared host or path whitelist. */
  whitelist?: string[];
};

/** The mic permission names an audioControl request may be gated behind. */
const MICROPHONE_PERMISSIONS = new Set(["g2-microphone", "phone-microphone", "microphone"]);

/** Short label shown as the permission's title in the confirmation dialog. */
export function permissionLabel(name: EvenHubPermissionName): string {
  switch (name) {
    case "network":
      return "Network access";
    case "location":
      return "Location";
    case "g2-microphone":
      return "Glasses microphone";
    case "phone-microphone":
      return "Phone microphone";
    case "microphone":
      return "Microphone";
    case "album":
      return "Photo album";
    case "camera":
      return "Camera";
    case "fs":
      return "Bundled files";
    default:
      return name;
  }
}

/** Secondary line under the label: the app's own description, or a default. */
export function permissionDetail(permission: EvenHubPermission): string {
  if (permission.description && permission.description.trim()) {
    return permission.description.trim();
  }
  if ((permission.name === "network" || permission.name === "fs") && permission.whitelist?.length) {
    return permission.whitelist.join(", ");
  }
  switch (permission.name) {
    case "network":
      return "Reach servers on the internet";
    case "location":
      return "Read your location";
    case "g2-microphone":
      return "Listen through the glasses microphone";
    case "phone-microphone":
      return "Listen through the phone microphone";
    case "microphone":
      return "Listen through the microphone";
    case "album":
      return "Read photos from your album";
    case "camera":
      return "Capture photos from the camera";
    default:
      return "";
  }
}

export function isMicrophonePermission(name: EvenHubPermissionName): boolean {
  return MICROPHONE_PERMISSIONS.has(name);
}

/** Whether the declared set includes a permission by name. */
export function permissionsInclude(permissions: EvenHubPermission[], name: EvenHubPermissionName): boolean {
  return permissions.some((permission) => permission.name === name);
}

/** Whether the declared set includes any microphone permission. */
export function permissionsIncludeMicrophone(permissions: EvenHubPermission[]): boolean {
  return permissions.some((permission) => isMicrophonePermission(permission.name));
}

/**
 * Parse the manifest's raw `permissions` value into a normalized list,
 * accepting both the array and the older map shape. Unknown names pass through
 * so the confirmation dialog still surfaces them.
 */
export function parsePermissions(raw: unknown): EvenHubPermission[] {
  const out: EvenHubPermission[] = [];
  const seen = new Set<string>();
  const add = (permission: EvenHubPermission) => {
    const name = String(permission.name).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ ...permission, name });
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") {
        add({ name: entry });
      } else if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const name = record.name;
        if (typeof name !== "string" || !name.trim()) continue;
        const description = typeof record.desc === "string"
          ? record.desc
          : typeof record.description === "string"
            ? record.description
            : undefined;
        const whitelist = Array.isArray(record.whitelist)
          ? record.whitelist.map(String)
          : undefined;
        add({ name, description, whitelist });
      }
    }
  } else if (raw && typeof raw === "object") {
    // Older map shape: {"network": ["host", ...], "fs": ["./assets"]}.
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const whitelist = Array.isArray(value) ? value.map(String) : undefined;
      add({ name, whitelist });
    }
  }
  return out;
}

/**
 * A stable signature of a granted permission set, for comparing what the user
 * confirmed against what a later version of the app declares.
 */
export function permissionsSignature(permissions: EvenHubPermission[]): string {
  return permissions
    .map((permission) => {
      const list = permission.whitelist?.length ? `(${[...permission.whitelist].sort().join(",")})` : "";
      return `${permission.name}${list}`;
    })
    .sort()
    .join(";");
}
