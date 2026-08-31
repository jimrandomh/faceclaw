/**
 * Minimal client for the Roam Research backend API
 * (https://roamresearch.com/#/app/developer-documentation): pull a page's
 * block tree, run datalog queries, and apply block writes. Configured by the
 * Roam graph/token settings; all calls are plain JSON POSTs from the app
 * worker via fetch.
 */
import { roamApiTokenSetting, roamGraphNameSetting } from "../../ui/dashboard-settings";
import { fetchWithUserAgent } from "../../util/http";

const API_BASE = "https://api.roamresearch.com";
const FETCH_TIMEOUT_MS = 12_000;

export type RoamBlock = {
  uid: string;
  string: string;
  order: number;
  /** Roam heading level 1-3, when set on the block. */
  heading?: number;
  children: RoamBlock[];
};

export type RoamPage = {
  uid: string;
  title: string;
  children: RoamBlock[];
};

export function isRoamConfigured(): boolean {
  return roamGraphNameSetting.get().length > 0 && roamApiTokenSetting.get().length > 0;
}

/** Daily-note page uid for a date (Roam's fixed MM-DD-YYYY convention). */
export function dailyPageUid(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}-${date.getFullYear()}`;
}

/** Daily-note page title for a date, e.g. "August 3rd, 2026". */
export function dailyPageTitle(date: Date): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const day = date.getDate();
  const teens = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teens ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${months[date.getMonth()]} ${day}${suffix}, ${date.getFullYear()}`;
}

/** Pull a page (or block) and its whole subtree; null when the uid doesn't exist. */
export async function fetchPageByUid(uid: string): Promise<RoamPage | null> {
  const selector = "[:block/uid :node/title :block/string :block/order :block/heading {:block/children ...}]";
  const response = await roamPost("pull", { eid: `[:block/uid "${uid.replace(/["\\]/g, "")}"]`, selector });
  const pulled = response?.result;
  if (!pulled) return null;
  return {
    uid: pulled[":block/uid"] ?? uid,
    title: pulled[":node/title"] ?? pulled[":block/string"] ?? "",
    children: pulledChildren(pulled),
  };
}

/** Look up a page's uid by exact title; null when no such page exists. */
export async function findPageUidByTitle(title: string): Promise<string | null> {
  const response = await roamPost("q", {
    query: "[:find ?uid :in $ ?title :where [?p :node/title ?title] [?p :block/uid ?uid]]",
    args: [title],
  });
  const rows = response?.result;
  return Array.isArray(rows) && rows.length > 0 ? String(rows[0][0]) : null;
}

export async function updateBlockString(uid: string, text: string): Promise<void> {
  await roamPost("write", { action: "update-block", block: { uid, string: text } });
}

export async function createBlock(parentUid: string, order: number | "last", text: string): Promise<void> {
  await roamPost("write", {
    action: "create-block",
    location: { "parent-uid": parentUid, order },
    block: { string: text },
  });
}

export async function createPage(title: string, uid?: string): Promise<void> {
  const page: Record<string, string> = { title };
  if (uid) page.uid = uid;
  await roamPost("write", { action: "create-page", page });
}

// ---------------------------------------------------------------------------
// Transport

// The API 308-redirects each request to a per-graph peer host. Whether the
// HTTP stack replays the POST across hosts varies, so on a redirect status we
// follow the Location header ourselves and remember the peer for next time.
// The token rides in x-authorization as well, because Authorization is what
// redirect-following stacks are most likely to strip.
let cachedPeerBase: string | null = null;

async function roamPost(endpoint: "q" | "pull" | "write", body: object): Promise<any> {
  const graph = roamGraphNameSetting.get();
  const token = roamApiTokenSetting.get();
  if (!graph || !token) {
    throw new Error("Set the Roam graph name and API token from the Roam app's long-press menu.");
  }
  const path = `/api/graph/${encodeURIComponent(graph)}/${endpoint}`;
  const payload = JSON.stringify(body);

  let base = cachedPeerBase ?? API_BASE;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}${path}`, payload, token);
    } catch (error) {
      if (base !== API_BASE) {
        // A stale peer host is the likely cause; retry once from the top.
        cachedPeerBase = null;
        base = API_BASE;
        continue;
      }
      throw new Error(`Roam API request failed: ${(error as Error)?.message ?? error}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("Location") ?? response.headers?.get?.("location");
      if (!location) throw new Error(`Roam API redirected without a Location header (HTTP ${response.status}).`);
      const match = /^(https:\/\/[^/]+)/.exec(location);
      if (!match) throw new Error(`Roam API redirect target not understood: ${location}`);
      cachedPeerBase = match[1]!;
      base = cachedPeerBase;
      continue;
    }
    if (!response.ok) {
      throw new Error(await describeHttpError(response));
    }
    try {
      return await response.json();
    } catch {
      return null; // Writes may return an empty body.
    }
  }
  throw new Error("Roam API request failed: too many redirects.");
}

async function fetchWithTimeout(url: string, payload: string, token: string): Promise<Response> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const request = fetchWithUserAgent(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
      "x-authorization": `Bearer ${token}`,
    },
    body: payload,
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("timed out")), FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function describeHttpError(response: Response): Promise<string> {
  if (response.status === 401) return "Roam API rejected the token (check Set API token in the menu).";
  if (response.status === 404) return "Roam graph not found (check Set graph name in the menu).";
  if (response.status === 429) return "Roam API rate limit hit; try again shortly.";
  if (response.status === 503) return "Roam graph is not ready yet; try again shortly.";
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.message ? `: ${body.message}` : "";
  } catch {
    // Body wasn't JSON; the status alone will do.
  }
  return `Roam API error (HTTP ${response.status})${detail}`;
}

function pulledChildren(pulled: any): RoamBlock[] {
  const children = pulled?.[":block/children"];
  if (!Array.isArray(children)) return [];
  const blocks = children.map(pulledBlock);
  blocks.sort((a, b) => a.order - b.order);
  return blocks;
}

function pulledBlock(pulled: any): RoamBlock {
  const block: RoamBlock = {
    uid: String(pulled?.[":block/uid"] ?? ""),
    string: String(pulled?.[":block/string"] ?? ""),
    order: Number(pulled?.[":block/order"] ?? 0),
    children: pulledChildren(pulled),
  };
  const heading = Number(pulled?.[":block/heading"] ?? 0);
  if (heading >= 1 && heading <= 3) block.heading = heading;
  return block;
}
