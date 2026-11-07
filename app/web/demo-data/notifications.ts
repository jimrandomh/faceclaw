import type { AndroidNotification } from "../../native/notification-types";

type Sample = { packageName: string; appName: string; title: string; text: string; category?: string; lines?: string[]; actions?: string[] };

/** Bundle ids pick the status-bar icon (notification-app-icons.ts). Everyone here is made up. */
const SAMPLES: readonly Sample[] = [
  { packageName: "com.apple.MobileSMS", appName: "Messages", title: "Sam Rivera", text: "Running 10 minutes late, order me a coffee?", actions: ["Reply", "Mark as read"] },
  { packageName: "com.apple.mobilemail", appName: "Mail", title: "Build report", text: "All 578 checks passed on main. Nothing needs your attention today, so go enjoy your lunch." },
  { packageName: "com.apple.mobilecal", appName: "Calendar", title: "Design review", text: "Starts in 15 minutes in Room 4" },
  { packageName: "com.apple.reminders", appName: "Reminders", title: "Water the plants", text: "Today" },
  { packageName: "com.apple.news", appName: "News", title: "Smart glasses, one year on", text: "Reviewers keep asking the same question: what would you actually look at all day?" },
  { packageName: "com.apple.weather", appName: "Weather", title: "Rain starting soon", text: "Light rain in about 20 minutes." },
  { packageName: "com.apple.Fitness", appName: "Fitness", title: "Time to stand", text: "One minute of walking closes your ring." },
  { packageName: "com.apple.MobileSMS", appName: "Messages", title: "Jordan", text: "Did you see the sunset? Look up!", actions: ["Reply", "Mark as read"] },
];

const active: AndroidNotification[] = [];
const posted = new Set<(key: string) => void>();
const removed = new Set<(key: string) => void>();
const popups = new Set<(key: string) => void>();
let nextSample = 0;
let nextKey = 1;

function makeNotification(sample: Sample, ageMs: number): AndroidNotification {
  const now = Date.now() - ageMs;
  return {
    key: `demo-${nextKey++}`,
    packageName: sample.packageName,
    appName: sample.appName,
    title: sample.title,
    text: sample.text,
    bigText: sample.text,
    subText: "",
    infoText: "",
    summaryText: "",
    category: sample.category ?? "",
    lines: sample.lines ?? [],
    postTime: now,
    when: now,
    actions: (sample.actions ?? []).map((title, index) => ({ index, title, enabled: true })),
  };
}

export function seedDemoNotifications(): void {
  active.unshift(makeNotification(SAMPLES[3]!, 40 * 60_000), makeNotification(SAMPLES[1]!, 12 * 60_000));
  for (const listener of [...posted]) listener("");
}

/** The next sample, delivered as a real notification would be (popup included). */
export function postDemoNotification(): void {
  const sample = SAMPLES[nextSample++ % SAMPLES.length]!;
  const notification = makeNotification(sample, 0);
  active.unshift(notification);
  if (active.length > 12) active.pop();
  for (const listener of [...posted]) listener(notification.key);
  for (const listener of [...popups]) listener(notification.key);
}

export function activeDemoNotifications(max: number): AndroidNotification[] {
  return active.slice(0, Math.max(0, max));
}

export function dismissDemoNotification(key: string): boolean {
  const index = active.findIndex((notification) => notification.key === key);
  if (index < 0) return false;
  active.splice(index, 1);
  for (const listener of [...removed]) listener(key);
  return true;
}

export function onDemoNotificationPosted(listener: (key: string) => void): () => void {
  posted.add(listener);
  return () => { posted.delete(listener); };
}

export function onDemoNotificationRemoved(listener: (key: string) => void): () => void {
  removed.add(listener);
  return () => { removed.delete(listener); };
}

export function onDemoNotificationPopup(listener: (key: string) => void): () => void {
  popups.add(listener);
  return () => { popups.delete(listener); };
}
