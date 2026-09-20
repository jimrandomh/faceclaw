import { Application, Utils } from "@nativescript/core";

const PERMISSION_REQUEST_CODE = 4242;
const VOICE_PERMISSION_REQUEST_CODE = 4243;
const CALENDAR_PERMISSION_REQUEST_CODE = 4244;
const LOCATION_PERMISSION_REQUEST_CODE = 4245;
const FINE_LOCATION_PERMISSION_REQUEST_CODE = 4246;
const BLE_ONLY_PERMISSION_REQUEST_CODE = 4247;
const POST_NOTIFICATIONS_PERMISSION_REQUEST_CODE = 4248;
const POST_NOTIFICATIONS_PERMISSION = "android.permission.POST_NOTIFICATIONS";
const RECORD_AUDIO_PERMISSION = "android.permission.RECORD_AUDIO";
const READ_CALENDAR_PERMISSION = "android.permission.READ_CALENDAR";
const ACCESS_COARSE_LOCATION_PERMISSION = "android.permission.ACCESS_COARSE_LOCATION";
const ACCESS_FINE_LOCATION_PERMISSION = "android.permission.ACCESS_FINE_LOCATION";

function getActivity(): androidx.appcompat.app.AppCompatActivity {
  const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
  if (!activity) throw new Error("No Android activity is available");
  return activity;
}

function getContext(): android.content.Context {
  const context = Utils.android.getApplicationContext();
  if (!context) throw new Error("No Android application context is available");
  return context;
}

function toJavaStringArray(values: string[]): string[] {
  const result = Array.create("java.lang.String", values.length) as string[];
  for (let i = 0; i < values.length; i++) {
    result[i] = values[i]!;
  }
  return result;
}

/** The runtime permissions this Android version needs for BLE scan + connect. */
function getBlePermissions(): string[] {
  if (android.os.Build.VERSION.SDK_INT >= 31) {
    return [
      android.Manifest.permission.BLUETOOTH_SCAN,
      android.Manifest.permission.BLUETOOTH_CONNECT,
    ];
  }
  return [android.Manifest.permission.ACCESS_FINE_LOCATION];
}

function getRequiredPermissions(): string[] {
  const permissions = getBlePermissions();
  if (android.os.Build.VERSION.SDK_INT >= 33) {
    permissions.push(POST_NOTIFICATIONS_PERMISSION);
  }
  return permissions;
}

function isPermissionGranted(permission: string): boolean {
  const context = getContext();
  return androidx.core.content.ContextCompat.checkSelfPermission(context, permission) ===
    android.content.pm.PackageManager.PERMISSION_GRANTED;
}

async function ensurePermissions(
  permissions: string[],
  requestCode: number,
  denialLabel: string,
): Promise<void> {
  if (!global.isAndroid) return;

  const activity = getActivity();
  const missing = permissions.filter((permission) => !isPermissionGranted(permission));

  if (missing.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const callback = (args: {
      requestCode: number;
      permissions: string[];
      grantResults: number[];
    }) => {
      if (args.requestCode !== requestCode) return;
      Application.android.off(Application.android.activityRequestPermissionsEvent, callback);

      const denied = missing.filter(
        (_permission, index) =>
          args.grantResults[index] !== android.content.pm.PackageManager.PERMISSION_GRANTED,
      );

      if (denied.length > 0) {
        reject(new Error(`${denialLabel} permissions denied: ${denied.join(", ")}`));
        return;
      }
      resolve();
    };

    Application.android.on(Application.android.activityRequestPermissionsEvent, callback);
    androidx.core.app.ActivityCompat.requestPermissions(
      activity,
      toJavaStringArray(missing),
      requestCode,
    );
  });
}

export async function ensureBlePermissions(): Promise<void> {
  await ensurePermissions(getRequiredPermissions(), PERMISSION_REQUEST_CODE, "Bluetooth");
}

export async function ensureVoicePermissions(): Promise<void> {
  await ensurePermissions([RECORD_AUDIO_PERMISSION], VOICE_PERMISSION_REQUEST_CODE, "Voice control");
}

/** Whether the BLE scan/connect permissions have been granted (false off-Android). */
export function hasBlePermissions(): boolean {
  if (!global.isAndroid) return false;
  return getBlePermissions().every((permission) => isPermissionGranted(permission));
}

/**
 * Prompt for just the BLE permissions (without POST_NOTIFICATIONS, which the
 * Permissions screen presents as its own card). Resolves true when granted.
 */
export async function requestBlePermissions(): Promise<boolean> {
  if (!global.isAndroid) return false;
  try {
    await ensurePermissions(getBlePermissions(), BLE_ONLY_PERMISSION_REQUEST_CODE, "Bluetooth");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether posting notifications is allowed. Before Android 13 (sdk 33) there
 * is no runtime permission for this, so it reports as granted.
 */
export function hasPostNotificationsPermission(): boolean {
  if (!global.isAndroid) return false;
  if (android.os.Build.VERSION.SDK_INT < 33) return true;
  return isPermissionGranted(POST_NOTIFICATIONS_PERMISSION);
}

/** Prompt for POST_NOTIFICATIONS. Resolves true when the permission is held afterward. */
export async function requestPostNotificationsPermission(): Promise<boolean> {
  if (!global.isAndroid) return false;
  if (android.os.Build.VERSION.SDK_INT < 33) return true;
  try {
    await ensurePermissions(
      [POST_NOTIFICATIONS_PERMISSION],
      POST_NOTIFICATIONS_PERMISSION_REQUEST_CODE,
      "Notification",
    );
    return true;
  } catch {
    return false;
  }
}

/** Whether RECORD_AUDIO has been granted (false off-Android). */
export function hasMicrophonePermission(): boolean {
  if (!global.isAndroid) return false;
  return isPermissionGranted(RECORD_AUDIO_PERMISSION);
}

/** Prompt for RECORD_AUDIO. Resolves true when granted, false on denial. */
export async function requestMicrophonePermission(): Promise<boolean> {
  if (!global.isAndroid) return false;
  try {
    await ensureVoicePermissions();
    return true;
  } catch {
    return false;
  }
}

/** Whether READ_CALENDAR has been granted (false off-Android). */
export function hasCalendarPermission(): boolean {
  if (!global.isAndroid) return false;
  return isPermissionGranted(READ_CALENDAR_PERMISSION);
}

/**
 * Prompt for READ_CALENDAR if not already granted. Resolves true when the
 * permission is held afterward, false if the user denied it (or no activity
 * was available to show the prompt).
 */
export async function ensureCalendarPermission(): Promise<boolean> {
  if (!global.isAndroid) return false;
  try {
    await ensurePermissions([READ_CALENDAR_PERMISSION], CALENDAR_PERMISSION_REQUEST_CODE, "Calendar");
    return true;
  } catch {
    return false;
  }
}

/** Whether precise (GPS) foreground location access has been granted. */
export function hasFineLocationPermission(): boolean {
  if (!global.isAndroid) return false;
  return isPermissionGranted(ACCESS_FINE_LOCATION_PERMISSION);
}

/**
 * Prompt for precise foreground location access (navigation needs GPS fixes
 * with bearing). Requests coarse alongside fine so Android's "approximate
 * only" choice degrades gracefully rather than denying outright; resolves
 * true only when precise access is actually held.
 */
export async function ensureFineLocationPermission(): Promise<boolean> {
  if (!global.isAndroid) return false;
  try {
    await ensurePermissions(
      [ACCESS_FINE_LOCATION_PERMISSION, ACCESS_COARSE_LOCATION_PERMISSION],
      FINE_LOCATION_PERMISSION_REQUEST_CODE,
      "Location",
    );
  } catch {
    // Fall through: the user may have granted approximate-only, which still
    // reports as a denial of fine. Re-check what is actually held.
  }
  return hasFineLocationPermission();
}

/** Whether approximate foreground location access has been granted. */
export function hasLocationPermission(): boolean {
  if (!global.isAndroid) return false;
  return isPermissionGranted(ACCESS_COARSE_LOCATION_PERMISSION);
}

/**
 * Prompt for approximate foreground location access. Weather only needs a
 * coarse coordinate, which avoids asking for more precise access than needed.
 */
export async function ensureLocationPermission(): Promise<boolean> {
  if (!global.isAndroid) return false;
  try {
    await ensurePermissions(
      [ACCESS_COARSE_LOCATION_PERMISSION],
      LOCATION_PERMISSION_REQUEST_CODE,
      "Location",
    );
    return true;
  } catch {
    return false;
  }
}
