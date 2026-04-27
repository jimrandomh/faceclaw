import { Application, Utils } from "@nativescript/core";

const PERMISSION_REQUEST_CODE = 4242;
const POST_NOTIFICATIONS_PERMISSION = "android.permission.POST_NOTIFICATIONS";

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

function getRequiredPermissions(): string[] {
  const sdk = android.os.Build.VERSION.SDK_INT;
  const permissions: string[] = [];

  if (sdk >= 31) {
    permissions.push(
      android.Manifest.permission.BLUETOOTH_SCAN,
      android.Manifest.permission.BLUETOOTH_CONNECT,
    );
  } else {
    permissions.push(android.Manifest.permission.ACCESS_FINE_LOCATION);
  }

  if (sdk >= 33) {
    permissions.push(POST_NOTIFICATIONS_PERMISSION);
  }

  return permissions;
}

export async function ensureBlePermissions(): Promise<void> {
  if (!global.isAndroid) return;

  const context = getContext();
  const activity = getActivity();
  const required = getRequiredPermissions();
  const missing = required.filter(
    (permission) =>
      androidx.core.content.ContextCompat.checkSelfPermission(context, permission) !==
      android.content.pm.PackageManager.PERMISSION_GRANTED,
  );

  if (missing.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const callback = (args: {
      requestCode: number;
      permissions: string[];
      grantResults: number[];
    }) => {
      if (args.requestCode !== PERMISSION_REQUEST_CODE) return;
      Application.android.off(Application.android.activityRequestPermissionsEvent, callback);

      const denied = missing.filter(
        (_permission, index) =>
          args.grantResults[index] !== android.content.pm.PackageManager.PERMISSION_GRANTED,
      );

      if (denied.length > 0) {
        reject(new Error(`Bluetooth permissions denied: ${denied.join(", ")}`));
        return;
      }
      resolve();
    };

    Application.android.on(Application.android.activityRequestPermissionsEvent, callback);
    androidx.core.app.ActivityCompat.requestPermissions(
      activity,
      toJavaStringArray(missing),
      PERMISSION_REQUEST_CODE,
    );
  });
}
