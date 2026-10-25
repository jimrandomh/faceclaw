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
  /** Full message size reported by iOS, even when the fetched text is bounded. */
  messageSize?: number;
};
