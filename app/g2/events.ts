export const EventSourceType = {
  TOUCH_EVENT_FORM_DUMMY_NULL: 0,
  TOUCH_EVENT_FROM_GLASSES_R: 1,
  TOUCH_EVENT_FROM_RING: 2,
  TOUCH_EVENT_FROM_GLASSES_L: 3,
  /**
   * Synthetic: the Wear OS remote (app/g2/wear-remote.ts). Not a firmware
   * value. Lets the UI give watch input its own, richer scheme (direct
   * spatial selection) while ring input keeps the stock one.
   */
  TOUCH_EVENT_FROM_WATCH: 4,
} as const;

export const EventSourceTypeName: Record<number, string> = {
  0: "TOUCH_EVENT_FORM_DUMMY_NULL",
  1: "TOUCH_EVENT_FROM_GLASSES_R",
  2: "TOUCH_EVENT_FROM_RING",
  3: "TOUCH_EVENT_FROM_GLASSES_L",
  4: "TOUCH_EVENT_FROM_WATCH",
};

/**
 * eEvenAIStatus, from EvenAIDataPackage.ctrl.status on sid 0x07
 * (UI_FOREGROUND_EVEN_AI_ID). WAKE_UP is the on-glasses "Hey Even" wakeword
 * firing; ENTER is a manual entry (touch/double-tap), so the two can be told
 * apart. EXIT is the assistant tearing down.
 */
export const EvenAIStatus = {
  STATUS_UNKNOWN: 0,
  EVEN_AI_WAKE_UP: 1,
  EVEN_AI_ENTER: 2,
  EVEN_AI_EXIT: 3,
} as const;

export const EvenAIStatusName: Record<number, string> = {
  0: "STATUS_UNKNOWN",
  1: "EVEN_AI_WAKE_UP",
  2: "EVEN_AI_ENTER",
  3: "EVEN_AI_EXIT",
};

/**
 * Synthetic gestures from the Wear OS remote (RawInputEvent kind
 * "watch-gesture"). Not a firmware enum: the glasses never send these.
 */
export const WatchGestureType = {
  SWIPE_LEFT: 0,
  SWIPE_RIGHT: 1,
  SWIPE_UP: 2,
  SWIPE_DOWN: 3,
} as const;

export const WatchGestureTypeName: Record<number, string> = {
  0: "SWIPE_LEFT",
  1: "SWIPE_RIGHT",
  2: "SWIPE_UP",
  3: "SWIPE_DOWN",
};

export const OsEventTypeList = {
  CLICK_EVENT: 0,
  SCROLL_TOP_EVENT: 1,
  SCROLL_BOTTOM_EVENT: 2,
  DOUBLE_CLICK_EVENT: 3,
  FOREGROUND_ENTER_EVENT: 4,
  FOREGROUND_EXIT_EVENT: 5,
  ABNORMAL_EXIT_EVENT: 6,
  SYSTEM_EXIT_EVENT: 7,
  IMU_DATA_REPORT: 8,
  RING_LONG_PRESS_EVENT: 9,
  RING_LONG_PRESS_RELEASE_EVENT: 10,
} as const;

export const OsEventTypeName: Record<number, string> = {
  0: "CLICK_EVENT",
  1: "SCROLL_TOP_EVENT",
  2: "SCROLL_BOTTOM_EVENT",
  3: "DOUBLE_CLICK_EVENT",
  4: "FOREGROUND_ENTER_EVENT",
  5: "FOREGROUND_EXIT_EVENT",
  6: "ABNORMAL_EXIT_EVENT",
  7: "SYSTEM_EXIT_EVENT",
  8: "IMU_DATA_REPORT",
  9: "RING_LONG_PRESS_EVENT",
  10: "RING_LONG_PRESS_RELEASE_EVENT",
};
