package local.wechat.accessibilityhelper;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private TextView status;
    private TextView tapStatus;
    private int taps;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        public void run() { update(); handler.postDelayed(this, 1000); }
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int pad = (int)(24 * getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);
        layout.setBackgroundColor(Color.rgb(244,247,245));
        scroll.addView(layout); setContentView(scroll);
        text(layout, "微信控件辅助 · 试验版", 24);
        text(layout, "用于验证：关闭系统屏幕朗读后，微信是否仍可读取控件。请求触摸探索模式，同时让普通触摸直接交给应用。", 16);
        text(layout, "本应用不朗读、不读取聊天内容、不截图、不联网，也不会发送消息。机器人仍由 AutoX 运行。", 16);
        status = text(layout, "", 17);
        button(layout, "打开无障碍设置", () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        button(layout, "关闭辅助服务", () -> {
            TouchModeService service = TouchModeService.instance;
            if (service != null) service.disableSelf();
            update();
        });
        tapStatus = text(layout, "单击计数：0", 17);
        button(layout, "单击测试（计数加一）", () -> tapStatus.setText("单击计数：" + (++taps)));
        text(layout, "开启方法：在系统设置中选择“微信控件辅助”并打开服务。若操作变为双击，请返回本页关闭服务；本试验尚未确认适配。", 14);
    }
    private TextView text(LinearLayout layout, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size);
        view.setTextColor(Color.rgb(22,58,49)); view.setPadding(0, 12, 0, 20);
        layout.addView(view); return view;
    }
    private void button(LinearLayout layout, String title, Runnable action) {
        Button button = new Button(this); button.setText(title);
        button.setOnClickListener(view -> action.run()); layout.addView(button);
    }
    private void update() {
        AccessibilityManager manager = getSystemService(AccessibilityManager.class);
        status.setText("服务连接：" + (TouchModeService.instance != null ? "已连接" : "未连接") +
            "\n触摸探索模式：" + (manager.isTouchExplorationEnabled() ? "已开启" : "未开启") +
            "\n" + TouchModeService.status);
    }
    @Override protected void onResume() { super.onResume(); handler.post(refresh); }
    @Override protected void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
}
