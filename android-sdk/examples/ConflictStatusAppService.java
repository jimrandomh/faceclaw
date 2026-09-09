package example.faceclaw;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import com.faceclaw.sdk.ExtensionDeclarations;
import com.faceclaw.sdk.FaceclawAppService;
import com.faceclaw.sdk.HostEvent;
import com.faceclaw.sdk.Protocol;
import com.faceclaw.sdk.WindowState;

/** A typography candidate that explains its own conflict state without parsing callback JSON. */
public final class ConflictStatusAppService extends FaceclawAppService {
    private final WindowState window = new WindowState();
    private String status = "Waiting for Faceclaw";

    @Override protected void onHostConnected() {
        publishExtensions(ExtensionDeclarations.builder().add(
                ExtensionDeclarations.Feature.FEATURE_UI_TYPOGRAPHY, true,
                Protocol.object("size", 16)).build());
    }

    @Override protected void onHostEvent(HostEvent event) {
        window.accept(event);
        if (event instanceof HostEvent.Extensions) {
            HostEvent.Feature feature = ((HostEvent.Extensions) event).feature("ui.typography");
            String component = new android.content.ComponentName(this, getClass()).flattenToString();
            HostEvent.Contender contender = feature == null ? null : feature.contender(component);
            if (contender == null) status = "No typography declaration";
            else switch (contender.reason) {
                case ACTIVE: status = "Typography is active"; break;
                case LOWER_PRIORITY: status = "Lower priority: " + contender.priority; break;
                case GRANT_REQUIRED: status = "Grant typography in host settings"; break;
                case DEPENDENCY_OWNER: status = "Needs same owner: " + android.text.TextUtils.join(", ", contender.requires); break;
                case DEPENDENCY_UNAVAILABLE: status = "Waiting for dependency"; break;
                case DISABLED: status = "Typography is disabled"; break;
                case DISCONNECTED: status = "Provider disconnected"; break;
                case INCOMPATIBLE: status = "Update app or host"; break;
                default: status = "Inspect host priority settings";
            }
        } else if (event instanceof HostEvent.ExtensionsRejected) {
            status = ((HostEvent.ExtensionsRejected) event).reason.equals("snapshot-capacity")
                    ? "Host customization capacity reached" : "Declaration rejected";
        }
        if (!window.canDraw()) return;
        Bitmap bitmap = Bitmap.createBitmap(window.width(), window.height(), Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.BLACK);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.WHITE); paint.setTextSize(16);
            canvas.drawText(status, 8, Math.min(24, window.height()), paint);
            submitBitmap(bitmap);
        } finally { bitmap.recycle(); }
    }

    @Override protected void onHostDisconnected() {
        window.disconnect(); status = "Disconnected";
    }
}
