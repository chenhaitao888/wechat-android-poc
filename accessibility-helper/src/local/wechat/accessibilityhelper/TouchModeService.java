package local.wechat.accessibilityhelper;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Point;
import android.graphics.Region;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;

// No window-content capability; no event contents or sources are inspected.
public final class TouchModeService extends AccessibilityService {
    static TouchModeService instance;
    static String status = "服务未运行";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private DisplayManager displays;
    private final DisplayManager.DisplayListener listener = new DisplayManager.DisplayListener() {
        public void onDisplayAdded(int id) { applyPassthrough(); }
        public void onDisplayRemoved(int id) { applyPassthrough(); }
        public void onDisplayChanged(int id) { applyPassthrough(); }
    };
    @Override protected void onServiceConnected() {
        instance = this;
        displays = getSystemService(DisplayManager.class);
        displays.registerDisplayListener(listener, handler);
        applyPassthrough();
        handler.postDelayed(() -> { if (instance == this) applyPassthrough(); }, 800);
    }
    @SuppressWarnings("deprecation") private void applyPassthrough() {
        try {
            Display display = displays.getDisplay(Display.DEFAULT_DISPLAY);
            if (display == null) throw new IllegalStateException("主屏幕不可用");
            Point size = new Point();
            display.getRealSize(size);
            if (size.x <= 0 || size.y <= 0) throw new IllegalStateException("屏幕尺寸无效");
            Region region = new Region(0, 0, size.x, size.y);
            setGestureDetectionPassthroughRegion(display.getDisplayId(), region);
            setTouchExplorationPassthroughRegion(display.getDisplayId(), region);
            status = "触摸直通已请求：" + size.x + " × " + size.y;
            Log.i("WechatTouchHelper", status);
        } catch (RuntimeException error) {
            status = "直通设置失败，已关闭：" + error.getClass().getSimpleName();
            Log.e("WechatTouchHelper", status);
            disableSelf();
        }
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        if (displays != null) applyPassthrough();
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() { }
    @Override public boolean onUnbind(Intent intent) {
        cleanUp();
        return super.onUnbind(intent);
    }
    @Override public void onDestroy() {
        cleanUp();
        super.onDestroy();
    }
    private void cleanUp() {
        handler.removeCallbacksAndMessages(null);
        if (displays != null) { displays.unregisterDisplayListener(listener); displays = null; }
        if (instance == this) instance = null;
        status = "服务已关闭";
    }
}
