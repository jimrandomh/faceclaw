import { Application, Dialogs, EventData, Frame, Observable, View } from "@nativescript/core";

import {
  ensureCalendarPermission,
  ensureFineLocationPermission,
  hasBlePermissions,
  hasCalendarPermission,
  hasFineLocationPermission,
  hasMicrophonePermission,
  hasPostNotificationsPermission,
  requestBlePermissions,
  requestMicrophonePermission,
  requestPostNotificationsPermission,
} from "../g2/android-permissions";
import { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } from "../native/battery-optimization";
import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../native/notification-access";

type PermissionDefinition = {
  id: string;
  title: string;
  description: string;
  optional: boolean;
  isGranted: () => boolean;
  /** Show the grant UI: a runtime-permission dialog or a system settings screen. */
  request: () => void | Promise<unknown>;
};

/**
 * Battery Optimization and Read Notifications are not runtime permissions:
 * their request() opens a system screen, so the granted state can only be
 * re-checked when the app resumes (the page refreshes on Application.resume).
 */
const PERMISSIONS: PermissionDefinition[] = [
  {
    id: "nearby-devices",
    title: "Nearby Devices",
    description: "Needed to communicate with your smart glasses over Bluetooth.",
    optional: false,
    isGranted: hasBlePermissions,
    request: requestBlePermissions,
  },
  {
    id: "post-notifications",
    title: "Send Notifications",
    description: "A notification will be pinned, to keep Faceclaw running while your phone screen is off.",
    optional: false,
    isGranted: hasPostNotificationsPermission,
    request: requestPostNotificationsPermission,
  },
  {
    id: "battery-optimization",
    title: "Battery Optimization",
    description: "Needed to keep running while your phone screen is off.",
    optional: false,
    isGranted: isIgnoringBatteryOptimizations,
    request: requestIgnoreBatteryOptimizations,
  },
  {
    id: "read-notifications",
    title: "Read Notifications",
    description: "Needed to display your Android notifications on the glasses.",
    optional: true,
    isGranted: isNotificationListenerEnabled,
    request: requestNotificationListenerAccess,
  },
  {
    id: "microphone",
    title: "Microphone",
    description: "Needed to use voice input.",
    optional: true,
    isGranted: hasMicrophonePermission,
    request: requestMicrophonePermission,
  },
  {
    id: "location",
    title: "Location",
    description: "Needed to use location-based features like navigation inside glasses apps.",
    optional: true,
    // Navigation needs precise fixes, so the checkmark tracks fine location;
    // "approximate only" leaves the card unchecked and re-tappable.
    isGranted: hasFineLocationPermission,
    request: ensureFineLocationPermission,
  },
  {
    id: "calendar",
    title: "Calendar",
    description: "Needed to display your calendar on the glasses.",
    optional: true,
    isGranted: hasCalendarPermission,
    request: ensureCalendarPermission,
  },
];

/** One Repeater card: the permission's copy plus the display-only fields the XML binds. */
export type PermissionCardItem = {
  id: string;
  title: string;
  description: string;
  optionalVisibility: "visible" | "collapse";
  checkVisibility: "visible" | "collapse";
  onCardTap: (args: EventData) => void;
};

/**
 * The Permissions screen: one card per Android permission Faceclaw uses, with
 * a checkmark when it is already granted and tap-to-grant otherwise. Reached
 * both from onboarding (between the disclaimer and the firmware step) and from
 * the main-screen menu.
 */
export class PermissionsViewModel extends Observable {
  private readonly onboarding: boolean;
  private _cards: PermissionCardItem[] = [];
  private requesting = false;

  constructor(options?: { onboarding?: boolean }) {
    super();
    this.onboarding = options?.onboarding ?? false;
    this.refresh();
  }

  /**
   * Battery Optimization and Read Notifications grant flows leave the app for
   * a system screen; re-check everything whenever the app comes back.
   */
  private readonly onAppResume = (): void => this.refresh();

  onPageLoaded(): void {
    Application.on(Application.resumeEvent, this.onAppResume);
    this.refresh();
  }

  onPageUnloaded(): void {
    Application.off(Application.resumeEvent, this.onAppResume);
  }

  // --- observable properties -------------------------------------------------

  get actionBarHidden(): boolean {
    return this.onboarding;
  }

  get headlineVisibility(): "visible" | "collapse" {
    return this.onboarding ? "visible" : "collapse";
  }

  get instructions(): string {
    return this.onboarding
      ? "Faceclaw uses these Android permissions. Tap a card to grant one; a checkmark means it is already granted. " +
          "Optional permissions can also be granted later, from the Permissions item in the main-screen menu."
      : "Tap a card to grant a permission; a checkmark means it is already granted.";
  }

  get cards(): PermissionCardItem[] {
    return this._cards;
  }

  get primaryLabel(): string {
    return this.onboarding ? "Continue" : "Done";
  }

  /**
   * Continue looks grayed out (but stays tappable — tapping it asks for
   * confirmation instead) while a required permission is missing. Done, in
   * menu mode, never dims: there is nothing to warn about when closing.
   */
  get primaryClass(): string {
    return this.onboarding && !this.requiredPermissionsGranted()
      ? "-primary permissions-primary-dimmed"
      : "-primary";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    return this.onboarding ? "visible" : "collapse";
  }

  // --- actions ---------------------------------------------------------------

  // Arrow property: NativeScript fires XML event handlers with `this` bound to
  // the tapped view's bindingContext (the card item), not the view model.
  readonly onCardTap = (args: EventData): void => {
    const item = (args.object as View).bindingContext as PermissionCardItem | undefined;
    if (!item || this.requesting) return;
    const definition = PERMISSIONS.find((permission) => permission.id === item.id);
    if (!definition || definition.isGranted()) return;
    void this.requestPermission(definition);
  };

  async onPrimaryTap(): Promise<void> {
    if (this.onboarding) {
      if (!this.requiredPermissionsGranted()) {
        const proceed = await Dialogs.confirm({
          title: "Missing Permissions",
          message: "You haven't enabled all of the necessary permissions. Are you sure you want to continue?",
          okButtonText: "Continue",
          cancelButtonText: "Go Back",
        });
        if (!proceed) return;
      }
      // Continue the onboarding chain at the Custom Firmware Required step.
      Frame.topmost()?.navigate({
        moduleName: "phone-ui/onboarding-page",
        context: { step: 3 },
      });
      return;
    }
    Frame.topmost()?.goBack();
  }

  onSecondaryTap(): void {
    Frame.topmost()?.goBack();
  }

  // --- rendering -------------------------------------------------------------

  private async requestPermission(definition: PermissionDefinition): Promise<void> {
    this.requesting = true;
    try {
      await definition.request();
    } catch {
      // A denial simply leaves the card unchecked; the user can tap again.
    } finally {
      this.requesting = false;
      this.refresh();
    }
  }

  private requiredPermissionsGranted(): boolean {
    return PERMISSIONS.every((definition) => definition.optional || definition.isGranted());
  }

  refresh(): void {
    this._cards = PERMISSIONS.map((definition) => ({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      optionalVisibility: definition.optional ? "visible" : "collapse",
      checkVisibility: definition.isGranted() ? "visible" : "collapse",
      onCardTap: this.onCardTap,
    }));
    this.notifyPropertyChange("cards", this._cards);
    this.notifyPropertyChange("primaryClass", this.primaryClass);
  }
}
