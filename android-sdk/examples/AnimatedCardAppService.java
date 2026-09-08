package example.faceclaw;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import com.faceclaw.sdk.FaceclawAppService;
import com.faceclaw.sdk.Ui;
import com.faceclaw.sdk.WindowAnimator;
import com.faceclaw.sdk.WindowMotion;
import org.json.JSONObject;

/** Optional shared card motion. Copy into a normal, host-approved SDK app. */
public final class AnimatedCardAppService extends FaceclawAppService {
    private int width, height;
    private boolean visible, screenOn = true, opened;
    private Bitmap body;
    private final WindowAnimator animator = new WindowAnimator(this::draw);
    private WindowMotion.Rect compact() { return new WindowMotion.Rect(16,16,Math.max(1,width-32),44); }
    private WindowMotion.Rect expanded() { return new WindowMotion.Rect(0,0,Math.max(1,width-5),Math.max(2,height-5)); }
    @Override public void onHostEvent(String type, JSONObject data) {
        if (type.equals("open") || type.equals("resize")) {
            cancelVisuals(); width=data.optInt("width"); height=data.optInt("height");
        } else if (type.equals("visibility")) {
            visible=data.optBoolean("visible"); screenOn=data.optBoolean("screenOn"); if(!visible || !screenOn)cancelVisuals();
        } else if(type.equals("shared-style")) {cancelVisuals();}
        else if(type.equals("close")) {visible=false;cancelVisuals();}
        else if(type.equals("input") && visible && screenOn && width>32 && height>48) {
            String input=data.optString("type");
            if(input.equals("click") || input.equals("double-click")) {
                boolean opening=input.equals("click") && !opened;
                if(opening==opened)return;
                opened=opening;
                if(!opening)releaseBody(); // No outgoing text layout or bitmap in closing frames.
                if(animator.isRunning())animator.retarget(opening?expanded():compact(),!opening);
                else animator.start(opening?compact():expanded(),opening?expanded():compact(),!opening);
                return;
            }
        }
        if(visible && screenOn && width>32 && height>48 && !animator.isRunning())drawSettled();
    }
    private void drawSettled() {
        WindowMotion motion=new WindowMotion(opened?expanded():compact(),opened?expanded():compact(),!opened);
        motion.sample(0);draw(motion.sample(WindowMotion.DURATION_MS));
    }
    private void draw(WindowMotion.Frame state) {
        if(!visible || !screenOn)return;
        Bitmap frame=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas=new Canvas(frame);canvas.drawColor(Color.BLACK);
            Ui.transitionCard(canvas,state,"EXAMPLE",bodyCanvas->{
                if(body==null) {
                    body=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
                    Canvas content=new Canvas(body);
                    // Layout/fetch only when bodyVisible, then reuse stable coordinates.
                    Ui.text(content,"Body appears at 90% open.",16,72,17,Color.LTGRAY);
                    Ui.text(content,"Back clears text before reversing.",16,97,17,Color.LTGRAY);
                }
                bodyCanvas.drawBitmap(body,0,0,null);
            });
            submitBitmap(frame); // SDK keeps one in-flight and one newest pending frame.
        } finally {frame.recycle();}
    }
    private void releaseBody(){if(body!=null){body.recycle();body=null;}}
    private void cancelVisuals(){animator.cancel();releaseBody();}
    @Override public void onHostDisconnected(){visible=false;cancelVisuals();width=height=0;}
}
