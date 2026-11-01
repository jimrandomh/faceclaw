import type { PebbleIconName } from "../graphics/pebble-icons";

/**
 * Icons for notification sources that arrive without one: iPhone
 * notifications over ANCS carry the app's bundle ID, its display name
 * (fetched separately) and an ANCS category, but no icon. The icons are
 * Pebble's (see scripts/generate-pebble-icons.cjs).
 *
 * The bundle IDs start from the Pebble firmware's own ANCS table (PebbleOS
 * include/pbl/services/notifications/ancs/ancs_known_apps.h, minus retired
 * apps), plus Apple's built-in apps and popular apps mapped to a generic
 * pictogram. Every App Store bundle ID here was checked against Apple's
 * iTunes lookup when it was added; Apple's built-in apps follow
 * github.com/joeblau/apple-bundle-identifiers.
 *
 * Display names are a fallback for apps whose bundle ID varies per build:
 * self-built apps such as Loop sign with their builder's team ID. They match
 * the whole name, ignoring case, so generic words (an app called "United"
 * or "Voice") are left out. Bundle prefixes catch regional variants
 * (com.abbott.librelink.us, .gb, ...).
 *
 * Apple's Phone app is deliberately absent: its notifications are calls,
 * missed calls and voicemail, which the ANCS category tells apart.
 */
type AppIcon = {
  icon: PebbleIconName;
  bundleIds: readonly string[];
  bundlePrefixes?: readonly string[];
  names?: readonly string[];
};

const APP_ICONS: readonly AppIcon[] = [
  // Apple's built-in apps.
  { icon: "sms", bundleIds: ["com.apple.MobileSMS"] },
  { icon: "email", bundleIds: ["com.apple.mobilemail"] },
  { icon: "calendar", bundleIds: ["com.apple.mobilecal"] },
  { icon: "reminder", bundleIds: ["com.apple.reminders"] },
  { icon: "facetime", bundleIds: ["com.apple.facetime"] },
  { icon: "iosPhotos", bundleIds: ["com.apple.mobileslideshow"] },
  { icon: "alarmClock", bundleIds: ["com.apple.mobiletimer"] },
  { icon: "weather", bundleIds: ["com.apple.weather"] },
  { icon: "location", bundleIds: ["com.apple.findmy", "com.apple.Maps"] },
  { icon: "settings", bundleIds: ["com.apple.Preferences"] },
  { icon: "heart", bundleIds: ["com.apple.Health"] },
  { icon: "activity", bundleIds: ["com.apple.Fitness"] },
  { icon: "news", bundleIds: ["com.apple.news"] },
  { icon: "podcast", bundleIds: ["com.apple.podcasts"] },
  { icon: "music", bundleIds: ["com.apple.Music"] },
  { icon: "tv", bundleIds: ["com.apple.tv"] },
  { icon: "payBill", bundleIds: ["com.apple.Passbook"] },
  { icon: "stocks", bundleIds: ["com.apple.stocks"] },
  { icon: "appStore", bundleIds: ["com.apple.AppStore"] },
  { icon: "appleShortcuts", bundleIds: ["com.apple.shortcuts"] },
  { icon: "microphone", bundleIds: ["com.apple.VoiceMemos"] },
  { icon: "contacts", bundleIds: ["com.apple.MobileAddressBook"] },
  { icon: "shopping", bundleIds: ["com.apple.store.Jolly"] },

  // Apps with an icon of their own.
  { icon: "airmail", bundleIds: ["com.airmailapp.iphone"], names: ["Airmail"] },
  { icon: "amazon", bundleIds: ["com.amazon.Amazon"], names: ["Amazon"] },
  { icon: "bbcNews", bundleIds: ["uk.co.bbc.news"], names: ["BBC News"] },
  { icon: "beeper", bundleIds: ["com.automattic.beeper"], names: ["Beeper"] },
  { icon: "bluesky", bundleIds: ["xyz.blueskyweb.app"], names: ["Bluesky"] },
  { icon: "discord", bundleIds: ["com.hammerandchisel.discord"], names: ["Discord"] },
  { icon: "duolingo", bundleIds: ["com.duolingo.DuolingoMobile"], names: ["Duolingo"] },
  { icon: "ebay", bundleIds: ["com.ebay.iphone"], names: ["eBay"] },
  { icon: "element", bundleIds: ["im.vector.app", "io.element.elementx"], names: ["Element", "Element X", "Element Classic"] },
  { icon: "facebook", bundleIds: ["com.facebook.Facebook"], names: ["Facebook"] },
  { icon: "gmail", bundleIds: ["com.google.Gmail"], names: ["Gmail"] },
  { icon: "googleChat", bundleIds: ["com.google.Dynamite"], names: ["Google Chat"] },
  { icon: "googleMaps", bundleIds: ["com.google.Maps"], names: ["Google Maps"] },
  { icon: "googlePhotos", bundleIds: ["com.google.photos"], names: ["Google Photos"] },
  { icon: "googleTasks", bundleIds: ["com.google.tasks"], names: ["Google Tasks"] },
  { icon: "homeAssistant", bundleIds: ["io.robbie.HomeAssistant"], names: ["Home Assistant"] },
  { icon: "instagram", bundleIds: ["com.burbn.instagram"], names: ["Instagram"] },
  { icon: "kakaoTalk", bundleIds: ["com.iwilab.KakaoTalk"], names: ["KakaoTalk"] },
  { icon: "kik", bundleIds: ["com.kik.chat"], names: ["Kik"] },
  { icon: "line", bundleIds: ["jp.naver.line"], names: ["LINE"] },
  { icon: "linkedIn", bundleIds: ["com.linkedin.LinkedIn"], names: ["LinkedIn"] },
  { icon: "messenger", bundleIds: ["com.facebook.Messenger"], names: ["Messenger"] },
  { icon: "omniFocus", bundleIds: ["com.omnigroup.OmniFocus4", "com.omnigroup.OmniFocus3.iOS"], names: ["OmniFocus"] },
  { icon: "outlook", bundleIds: ["com.microsoft.Office.Outlook"], names: ["Outlook"] },
  { icon: "reddit", bundleIds: ["com.reddit.Reddit"], names: ["Reddit"] },
  { icon: "signal", bundleIds: ["org.whispersystems.signal"], names: ["Signal"] },
  { icon: "simplex", bundleIds: ["chat.simplex.app"], names: ["SimpleX"] },
  { icon: "slack", bundleIds: ["com.tinyspeck.chatlyio"], names: ["Slack"] },
  { icon: "snapchat", bundleIds: ["com.toyopagroup.picaboo"], names: ["Snapchat"] },
  { icon: "steam", bundleIds: ["com.valvesoftware.Steam"], names: ["Steam"] },
  { icon: "substack", bundleIds: ["com.substack.Substack"], names: ["Substack"] },
  { icon: "swarm", bundleIds: ["com.foursquare.robin"], names: ["Swarm"] },
  { icon: "tapo", bundleIds: ["com.tplink.tapo"], names: ["Tapo"] },
  { icon: "teams", bundleIds: ["com.microsoft.skype.teams"], names: ["Teams", "Microsoft Teams"] },
  { icon: "telegram", bundleIds: ["ph.telegra.Telegraph"], names: ["Telegram"] },
  { icon: "threads", bundleIds: ["com.burbn.barcelona"], names: ["Threads"] },
  { icon: "tiktok", bundleIds: ["com.zhiliaoapp.musically"], names: ["TikTok"] },
  { icon: "twitch", bundleIds: ["tv.twitch"], names: ["Twitch"] },
  // X, still under Twitter's bundle ID and drawn with its bird, as on Pebble.
  { icon: "twitter", bundleIds: ["com.atebits.Tweetie2"], names: ["X", "Twitter"] },
  { icon: "unifiProtect", bundleIds: ["com.ubnt.protect"], names: ["UniFi Protect"] },
  { icon: "viber", bundleIds: ["com.viber"], names: ["Viber"] },
  { icon: "waze", bundleIds: ["com.waze.iphone"], names: ["Waze"] },
  { icon: "weChat", bundleIds: ["com.tencent.xin"], names: ["WeChat"] },
  { icon: "whatsApp", bundleIds: ["net.whatsapp.WhatsApp"], names: ["WhatsApp"] },
  { icon: "whatsAppBusiness", bundleIds: ["net.whatsapp.WhatsAppSMB"], names: ["WA Business", "WhatsApp Business"] },
  { icon: "yahooMail", bundleIds: ["com.yahoo.Aerogram"], names: ["Yahoo Mail"] },
  { icon: "youtube", bundleIds: ["com.google.ios.youtube"], names: ["YouTube"] },
  { icon: "zoom", bundleIds: ["us.zoom.videomeetings"], names: ["Zoom"] },

  // Apps drawn with a generic pictogram.
  { icon: "calendar", bundleIds: ["com.google.calendar", "com.flexibits.fantastical2.iphone"], names: ["Google Calendar", "Fantastical"] },
  { icon: "email", bundleIds: ["com.readdle.smartemail", "ch.protonmail.protonmail"], names: ["Proton Mail"] },
  { icon: "sms", bundleIds: ["com.google.GVDialer", "ch.threema.iapp", "com.groupme.iphone-app"], names: ["Threema", "GroupMe"] },
  { icon: "reminder", bundleIds: ["com.todoist.ios", "com.culturedcode.ThingsiPhone", "com.microsoft.to-do"], names: ["Todoist"] },
  { icon: "car", bundleIds: ["com.ubercab.UberClient", "com.zimride.instant"], names: ["Uber", "Lyft"] },
  { icon: "dinner", bundleIds: ["com.ubercab.UberEats", "doordash.DoorDashConsumer", "com.grubhub.search"], names: ["Uber Eats", "DoorDash", "Grubhub"] },
  {
    icon: "glucose",
    bundleIds: [
      "com.dexcom.G6", "com.dexcom.g7app", "com.dexcom.dexcomone", "com.dexcom.stelo", "com.dexcom.followglobal",
      "org.nativescript.LibreLinkUp",
    ],
    bundlePrefixes: ["com.abbott.librelink.", "com.abbott.libre3."],
    names: ["Dexcom G6", "Dexcom G7", "Dexcom ONE", "LibreLink", "LibreLinkUp", "Loop", "Trio", "LoopFollow", "xDrip4iOS"],
  },
  { icon: "music", bundleIds: ["com.spotify.client", "com.google.ios.youtubemusic", "com.pandora"], names: ["Spotify", "YouTube Music", "Pandora"] },
  { icon: "podcast", bundleIds: ["fm.overcast.overcast", "au.com.shiftyjelly.podcasts"], names: ["Overcast", "Pocket Casts"] },
  {
    icon: "tv",
    bundleIds: ["com.netflix.Netflix", "com.hulu.plus", "com.disney.disneyplus", "com.amazon.aiv.AIVApp"],
    names: ["Netflix", "Hulu", "Disney+", "Prime Video"],
  },
  {
    icon: "payBill",
    bundleIds: [
      "net.kortina.labs.Venmo", "com.squareup.cash", "com.yourcompany.PPClient", "com.chase", "com.bankofamerica.BofA",
      "com.wf.mobilebanking", "com.capitalone.enterprisemobilebanking",
      "com.revolut.revolut", "com.transferwise.Transferwise", "de.no26.Number26", "com.bunq.ios",
    ],
    names: ["Venmo", "Cash App", "PayPal", "Revolut", "N26", "bunq"],
  },
  { icon: "stocks", bundleIds: ["com.robinhood.release.Robinhood", "com.vilcsak.bitcoin2"], names: ["Robinhood", "Coinbase"] },
  {
    icon: "flight",
    bundleIds: [
      "com.united.UnitedCustomerFacingIPhone", "com.delta.iphone.ver1", "com.aa.AmericanAirlines",
      "com.southwest.iphoneprod", "com.flightyapp.flighty",
    ],
    names: ["Fly Delta", "Flighty"],
  },
  { icon: "weather", bundleIds: ["com.weather.TWC", "com.grailr.CARROTweather"] },
  { icon: "activity", bundleIds: ["com.strava.stravaride", "com.nike.nikeplus-gps", "com.fitbit.FitbitMobile"], names: ["Strava", "Fitbit"] },
  { icon: "heart", bundleIds: ["com.ouraring.oura"], names: ["Oura"] },
  { icon: "news", bundleIds: ["com.nytimes.NYTimes", "com.google.GoogleDigitalEditions"], names: ["Google News"] },
];

/**
 * Icons for the ANCS categories (CategoryID: Other, IncomingCall,
 * MissedCall, Voicemail, Social, Schedule, Email, News, HealthAndFitness,
 * BusinessAndFinance, Location, Entertainment), for apps not listed above.
 */
const CATEGORY_ICONS: readonly PebbleIconName[] = [
  "generic", "incomingCall", "missedCall", "voicemail", "sms", "calendar",
  "email", "news", "heart", "stocks", "location", "tv",
];

type Index = { bundleIds: Map<string, PebbleIconName>; prefixes: [string, PebbleIconName][]; names: Map<string, PebbleIconName> };
let index: Index | null = null;

function buildIndex(): Index {
  const built: Index = { bundleIds: new Map(), prefixes: [], names: new Map() };
  for (const app of APP_ICONS) {
    for (const id of app.bundleIds) built.bundleIds.set(id.toLowerCase(), app.icon);
    for (const prefix of app.bundlePrefixes ?? []) built.prefixes.push([prefix.toLowerCase(), app.icon]);
    for (const name of app.names ?? []) built.names.set(name.toLowerCase(), app.icon);
  }
  return built;
}

/**
 * The icon for a notification's source app, by bundle ID (ignoring case;
 * Apple treats bundle IDs case-insensitively), else by its display name;
 * null when the app isn't known.
 */
export function notificationAppIcon(bundleId: string, appName: string): PebbleIconName | null {
  index ??= buildIndex();
  const id = bundleId.trim().toLowerCase();
  if (id) {
    const byId = index.bundleIds.get(id) ?? index.prefixes.find(([prefix]) => id.startsWith(prefix))?.[1];
    if (byId) return byId;
  }
  const name = appName.trim().toLowerCase();
  return (name && index.names.get(name)) || null;
}

/** The icon for an ANCS category (a CategoryID as a string); the bell for anything unknown. */
export function notificationCategoryIcon(category: string): PebbleIconName {
  return CATEGORY_ICONS[Number(category)] ?? "generic";
}

/** Every icon the table refers to, for tests. */
export function allNotificationAppIcons(): PebbleIconName[] {
  return Array.from(new Set(APP_ICONS.map((app) => app.icon).concat(CATEGORY_ICONS)));
}
