/** Shared notification model; Android names are retained for existing callers. */
export type AndroidNotificationAction = { index: number; title: string; enabled: boolean };
export type AndroidNotification = {
  key: string; packageName: string; appName: string; title: string; text: string;
  bigText: string; subText: string; infoText: string; summaryText: string;
  category: string; lines: string[]; postTime: number; when: number;
  actions: AndroidNotificationAction[]; dismissLabel?: string;
  /** Posted by a foreground service (Android): a "this app is working" status notification. */
  foregroundService?: boolean;
  /** Carries a picture (Android BigPictureStyle), fetched separately by readNotificationPicture. */
  hasPicture?: boolean;
  /** Carries a large icon (Android: a sender's avatar or logo), fetched separately by readNotificationLargeIcon. */
  hasLargeIcon?: boolean;
  /** Has its own layout (Android RemoteViews), drawn by readNotificationCustomView. */
  hasCustomView?: boolean;
  /**
   * The custom layout's text, one entry per text view, when the notification has no title or
   * text of its own (Dexcom's glucose reading and units).
   */
  customText?: string[];
  /** Full message size reported by iOS, even when the fetched text is bounded. */
  messageSize?: number;
};
