# 安卓微信群 @ 固定回复 PoC

本项目验证《渠道微信群 AI 机器人方案.md》中的安卓真机路径。范围只包含测试群 `测试1`、机器人群昵称 `jarvis` 和固定测试回复，没有接入大模型、知识库或服务端。

## 获取与本地配置

代码仓库：`chenhaitao888/wechat-android-poc`。开发环境为 macOS、Python 3、Node.js（语法检查）、JDK 和 Android adb。机器人运行时只需要安卓手机，Mac 用于开发和部署。

克隆后将 `device.example.json` 复制为本地 `device.json`，填写 `adb devices -l` 显示的设备编号。本文命令里的 `YOUR_DEVICE_SERIAL` 需要替换为该编号。该文件是联调说明，脚本实际目标群仍固定为 `测试1`。

仓库只保存代码、配置示例和验证结论。`artifacts/` 原始聊天/诊断记录、`checkpoints/` 本机回退副本、`vendor/` 安装包和 SDK、设备编号、APK 以及 `.signing/` 私钥不上传。下文对这些路径的引用是本地联调留档，并非仓库随附文件。

## 当前结论

2026-10-20 已在华为 DCO-AL00（HarmonyOS 4.2.0 / Android 兼容版本 12）、微信 8.0.79、AutoX.js 7.2.4 mini 上打通：

`记录已读消息边界 → 微信会话列表出现 [有人@我] → 进入测试1核对整批未读 → 唯一可归属时发送固定回复 → 返回列表`

这台手机上，单独开启 AutoX 无障碍服务时，微信只暴露空的根节点；开启华为系统“屏幕朗读”后，聊天内容和输入框可读、可操作。前两轮成功结果依赖这个条件。第三阶段新建了“微信控件辅助”：系统屏幕朗读关闭时，已恢复微信控件读取（574 个节点），手指单击与无朗读声由用户确认；测试008自动回复、拔线后的测试009自动回复均已收到。机器人在手机上运行，不需要一直连接 Mac。只说明这组设备与版本的实验结果，尚不能证明不同机型、多群或全天运行可用。

## 测试记录

| 样本 | 触发方式 | 结果 |
| --- | --- | --- |
| 测试001 | 用户确认的真实 @，运行一次性发送脚本 | 发出气泡可见，用户确认另一台手机收到 |
| 测试002 | 从会话列表识别真实 @ 标记，自动进入群并回复 | 发出气泡可见，用户确认收到 |
| 测试003 | 监听脚本运行期间新到的真实 @ | 自动回复并返回列表，发出气泡可见 |
| 测试004 | 粘贴纯文本 @jarvis，不选择成员 | 无 @ 标记，脚本未发送；用户确认无回复 |
| 测试005 | 普通文字，无 @ | 脚本未发送；用户确认无回复 |

监听实际运行于 14:49:09–14:52:12（北京时间），自动发送仅两次，编号为 002、003。结束后已设置 STOP 并确认脚本停止，系统屏幕朗读已恢复关闭；关闭后复测，微信再次仅返回一个空根节点。AutoX 安装与无障碍服务保留。详细结构化结果见 `artifacts/test-results.json`。

## 触发条件和边界

- 只查找当前可见且唯一的 `测试1` 会话，不遍历其他群。
- 会话摘要必须以微信显示的 `[有人@我]` 开头，未读数为 `1–5`。整批必须是完整可见的收到的纯文字，且只出现一个 @ 符号，对应正文为 `@jarvis 测试NNN`（三位编号）。
- 启动时只在未读为0的测试群记录已读边界；进入群后的新增消息数必须等于未读数，最后一条必须与会话摘要一致。边界找不到、重复或内容变化就暂停。
- 进入群后再次核对标题、测试编号和消息方向；输入框非空就停止，不覆盖人工草稿。
- 发送前将编号写入去重记录。发送结果不确定时停止，不自动重试。相同测试编号不会再次回复。
- 手机面板每次启动最多 30 分钟、最多 10 条回复；可在手机面板点“停止回复”。脚本在手机上运行，不调用模型或网络接口。旧版命令行默认 10 分钟 / 5 条；若手机已有面板生成的 run-request.json，则按其中的 30 分钟模式运行。
- 多条 @、未读超过5条、摘要截断、消息未完整显示、图片/系统消息、界面被打断等情况会暂停或无法处理。本版不自动恢复复杂界面，不处理任意问题文字。
- 歧义批次进入群后可能已被微信标为已读；脚本将内容保存到本机 `artifacts/pending-batch.json` 并退出，面板显示原因，需要人工检查，不会自动补发。

`[有人@我]` 是会话级 UI 标记，不是每条消息的结构化 mention 元数据。本版通过“已读边界 + 完整未读批次 + 唯一 @ + 摘要与群内复核”限定验证范围。该方法基于当前设备的 UI 观察，不能替代消息级 mention 元数据，也不能保证高并发、聊天页内新到消息的完整捕获。多条 @ 的精确归属仍未解决。

## 文件

- `phone-panel.js`：手机上的开始、停止、状态查看和桌面入口。
- `watch-test-group.js`：限时单群监听、未读边界校验、固定回复、电量和 USB 状态记录。
- `mention-policy.js`：纯逻辑的未读批次判定；`tests/mention-policy.test.js` 覆盖12种边界与歧义情况。
- `inspect-test-group.js`：机器人停止时只读检查测试群的摘要、消息节点和 @ 元信息，不操作输入框。
- `probe.js`：只读 UI 诊断。完整诊断可能包含其他可见会话摘要，应留在本机排查。
- `send-once.js`：测试001的一次性历史验证脚本，不作为日常入口。
- `device.json` / `config.json`：设备与本次联调记录；config 是说明性清单，脚本的实际测试范围固定在代码中，停止由 STOP 文件控制。
- `restore-screen-reader.js`：通过正常设置界面关闭屏幕朗读的辅助脚本。
- `artifacts/phone-final/watch-state.json` / `artifacts/phone-final/watch-events.jsonl`：从手机保存的结果。
- `accessibility-helper/`：本地辅助应用源码与构建脚本。仅请求触摸探索能力，不申请联网、窗口内容、截图或手势执行能力。
- `inspect-ui.js`：不干扰其他无障碍服务的只读检查，只记录微信节点统计与测试群位置。
- `checkpoints/stage2-standalone/`：此前拔线验证版本的回退副本及 SHA-256。
- `vendor/`：官方 AutoX.js 安装包和已校验的 Google Android 编译工具。

安装包来自 [AutoX v7.2.4 官方发布](https://github.com/aiselp/AutoX/releases/tag/v7.2.4)，文件为 `Autox-v7_mini-arm64-v8a-release-v7.2.4.apk`，SHA-256：

```
33d2e1710ca98396ded2877cfb12a001f212b24fdb322dc67dd7d5e61d72c5e1
```

## 在手机上复测（不需要 Mac）

手机桌面已有 **“微信群测试”** 图标。它会打开控制面板，不会立即开始自动回复。

1. 手机联网、解锁。USB 连接 Mac 不再是复测前提。在系统无障碍设置中开启 AutoX 服务和“微信控件辅助”（第三阶段联调版本）。系统屏幕朗读保持关闭。面板里的“打开微信控件辅助”可查看状态、打开设置和关闭辅助服务。原有屏幕朗读方式仍作为回退。
2. 打开微信 `测试1` 群，读掉旧未读，确认输入框为空，再退回聊天列表。
3. 回到桌面，打开“微信群测试”，点 **“开始测试（30分钟）”**。程序会短暂进入测试群记录已读位置，再返回聊天列表；准备完成后再发送新消息，保持 `测试1` 可见。
4. 用另一台手机真正 @jarvis，发送面板提示的编号，例如 `测试016`。正常复测先发一条，等回复后再继续。批次联调可在一条真正 @ 后跟一条普通消息；同一批多条 @ 会暂停。
5. 测完回到桌面打开“微信群测试”，点 **“停止回复”**，等面板显示“已停止”。随后可以在“微信控件辅助”中点“关闭辅助服务”。

回退到系统屏幕朗读时，通常需要 **单击选中，再双击激活**。新辅助方式请求触摸直通，以保留普通单击；模拟触摸与用户手指单击均已通过，用户确认没有朗读声。系统屏幕朗读和辅助服务都关闭时，这台手机上的微信控件会变为不可读。

面板会显示当前状态、运行时间、本轮回复数量、下一个测试编号、辅助服务和系统屏幕朗读状态。查看面板期间不识别微信消息，点击“打开微信 / 返回等待”并回到聊天列表后继续。每轮最多 30 分钟或 10 条回复，达到任一限制后自动结束。

`测试NNN` 是群消息，不需要修改代码或配置。真正 @ 必须从微信成员列表选择 jarvis，直接粘贴纯文字 @jarvis 不会触发。已处理过的编号不会重复回复。

### 本轮脱离 Mac 的验证

- 桌面入口打开面板：已验证。
- 旧版屏幕朗读未开启时阻止启动：已验证。第三阶段面板改为允许新辅助服务或系统朗读二者之一，并检查触摸模式。
- 手机面板开始与停止监听：已验证。
- 重复打开面板只保留一个面板实例：已验证。
- 重复启动锁、去重记录损坏、STOP 三种异常路径：离线检查通过，均未调用微信 UI 操作。
- 拔掉 USB 后从手机开始、识别 @ 和回复：已通过，测试006、007均由对端确认收到。
- 10 分钟静置复测：已通过。实际两次发送间隔约 12 分钟，整轮运行约 13 分 15 秒（15:48:20–16:01:35，北京时间）。
- 手机面板停止：用户操作并确认“已停止”；日志与停止标记一致，监听锁已释放。
- 本轮13条运行状态记录均显示 USB 断开，相邻记录最大间隔约69秒，未记录到异常停止或重复发送。这个采样不能代替全天稳定性测试。
- 结束后屏幕朗读已恢复关闭，AutoX 服务及桌面入口保留。下一次使用 `测试008` 等新编号。

结构化结果见 `artifacts/standalone-test-results.json`，原始日志在 `artifacts/standalone-final/`。配置的30分钟自动停止尚未等满验证，本轮由手机按钮主动停止。

### 辅助应用构建与回退

在项目根目录先运行 `python3 scripts/setup-sdk.py` 准备已固定版本的 Google SDK（macOS），然后运行 `python3 accessibility-helper/build.py`，产物为 `accessibility-helper/build/wechat-accessibility-helper.apk`。使用本机 JDK、Google 官方 Android 35 平台与 Build Tools 35.0.0，不依赖 Gradle 或第三方库。签名文件仅用于本地联调，存放在 `accessibility-helper/.signing/`，不要提交或分享。

工具包 SHA-1 已与 Google 仓库元数据核对：`platform-35_r02.zip` 为 `0bb560a90a7a2cbd0dd8348224d518b638fe7949`；`build-tools_r35_macosx.zip` 为 `93ab8ce91230e067b5add4bfa79919c52b27f072`。

如需回退，先确认面板停止，再使用 `checkpoints/stage2-standalone/` 内的脚本替换手机同名脚本，关闭“微信控件辅助”并恢复系统屏幕朗读。不要覆盖或清空手机的 `artifacts/watch-state.json`，保留已处理编号。

### 开发维护命令（正常复测不需要）

更新脚本：

```sh
cd "wechat-android-poc"
adb -s YOUR_DEVICE_SERIAL push watch-test-group.js mention-policy.js phone-panel.js /sdcard/wechat-android-poc/
```

连接 Mac 时可以用下面的命令打开面板：

```sh
adb -s YOUR_DEVICE_SERIAL shell am start -n org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity -d file:///sdcard/wechat-android-poc/phone-panel.js
```

请求停止并查看状态：

```sh
adb -s YOUR_DEVICE_SERIAL shell touch /sdcard/wechat-android-poc/STOP
adb -s YOUR_DEVICE_SERIAL shell cat /sdcard/wechat-android-poc/artifacts/watch-state.json
```

程序保留已处理编号；不要为了重试删除 watch-state.json。异常退出后若残留 watch.lock，需要先确认监听引擎已退出再处理，面板不会自动忽略这类异常。

实现参考：[AutoX UI](https://v7.autoxjs.dayudada.com/docs/rhino/base/ui/)、[AutoX 脚本引擎](https://v7.autoxjs.dayudada.com/docs/rhino/advanced/engines/)、[Android 桌面快捷方式](https://developer.android.com/develop/ui/compose/system/shortcuts/creating-shortcuts)。

## 第三阶段：关闭系统朗读后的控件兼容性（基础验证通过）

- AutoX 单独运行：微信为空根节点；仅修改 AutoX 反馈类型，仍无可用控件。
- 最小辅助应用已编译并安装，系统正常授权后 `touchExplorationEnabled=true`，系统朗读服务未启用。
- 系统确认辅助应用能力仅为 `CAPABILITY_CAN_REQUEST_TOUCH_EXPLORATION`（数值 2）；APK 没有申请联网等权限。
- 使用 Android API 30 的触摸与手势直通区域，覆盖当前主屏幕；没有语音、读屏、截图或消息发送逻辑。
- 辅助应用页面模拟单击计数由 0 变为 1。微信列表恢复为 574 个节点，157 个有非空边界，能定位“测试1”。
- 手指单击、无朗读声：用户确认通过；无需单击选中后再双击。
- 测试008：关闭系统朗读、开启新辅助服务，自动回复且用户确认收到。
- 测试009：用户拔掉 USB 后自动回复且确认收到；Mac 侧无连接设备，手机运行记录显示 USB 断开。
- 新模式本轮运行约 2 分 18 秒（16:26:42–16:29:01，北京时间），008/009 各发送一次，没有异常停止记录。用户通过桌面面板普通单击停止，最终状态 stopped，STOP 存在且监听锁已释放。
- 结束时系统朗读关闭，AutoX 和控件辅助服务保留开启，自动回复停止。下次使用测试010等新编号。
- 辅助服务关闭后重新开启的恢复、后台/锁屏和更长时间稳定性仍待测试。此前 006/007 的约13分钟测试属于系统朗读模式，不计为本模式的长时验证。
- `uiautomator dump` 会临时停用其他无障碍服务，检查本模式应使用 `inspect-ui.js`，避免工具本身干扰结果。

实现依据：[Android AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#setTouchExplorationPassthroughRegion(int,android.graphics.Region))。结果见 `artifacts/helper-test-results.json`，控件诊断见 `artifacts/helper-wechat-on.json`，运行原始日志见 `artifacts/helper-final-watch-events.jsonl`；旧版回退文件见 `checkpoints/stage2-standalone/`。

## 第四阶段：多条未读（限定范围通过）

| 真机案例 | 未读情况 | 结果 |
| --- | --- | --- |
| 测试010 + 普通011 | 只读观察两条未读 | 群摘要保留 @ 标记，但正文显示最后的普通消息；消息控件中未获得单条 mention 元数据 |
| 真正 @ 测试012 + 普通013 | 两条同时未读，摘要是013 | 识别并仅回复012一次，用户确认收到 |
| 真正 @ 测试014 + 用户确认粘贴的纯文字 @ 测试015 | 两条同时未读 | 判定歧义并暂停，两条均无发送尝试；本机留存待检查批次 |

本轮为16:48:32–16:51:41（北京时间），仅发送012一次，最终因预期的歧义测试退出。STOP保留、监听锁已释放，辅助服务开启、系统朗读关闭。此结果不能解释成支持同一批多条真正 @ 的自动回复。真机本轮验证了两条未读；虽然代码上限是5条，3–5条在不同消息长度下的可见性仍待真机验证。

运行离线验证（Node.js 18+）：

```sh
node --test tests/mention-policy.test.js
```

12个用例覆盖普通消息夹杂、真假 @ 混合、多个真正 @、@所有人/引用、去重、边界丢失/重复、进入群期间插入消息、摘要截断和不支持的消息类型。测试只验证分类决策，真机交互另有上述记录。

开发联调用 `TEST_HOLD` 文件暂缓处理，以确保两条消息先积累成同一批；正常使用不需要该文件。本轮结束已移除。原始结果仅保存在本机 `artifacts/batch-test-results.json`、`batch-final-watch-events.jsonl`、`batch-pending.json`，不上传仓库。

## 下一阶段验证

手机操作入口、短时拔线运行和当前设备上系统屏幕朗读的替代方式已验证。当前已支持限定条件下的一条 @ 混合普通文字；同一批多条 @ 仍需可靠的消息级定位证据。后续验证较长时间连续运行、锁屏/后台恢复、辅助服务重启、断网、同名群及微信升级，逐步延长到24小时。之后从少量测试群扩展并测量漏答、误答、重复回复和响应时延。当前尚未验证方案中 60 多个群的承载能力。
