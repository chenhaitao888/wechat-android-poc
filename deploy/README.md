# ECS 部署交接：Ubuntu 22.04.5，直接运行在宿主机

目标架构：安卓手机在办公网络，通过已申请的 HTTPS 域名上报问题、领取经人工审核的答案。渠道后台和业务查询服务直接运行在 ECS；Hermes 继续使用宿主机安装。Hermes 原有命令执行环境不属于此次改动范围。

本目录是待环境确认后的部署模板。**当前没有部署到 ECS，也没有把手机切到网络模式。** 现有单群、模拟数据、逐条人工审核、每轮 30 分钟/10 条回复的限制保留。

## 交付内容和执行范围

本文交给部署人员自行执行，不需要把公司服务器权限或密钥交给开发助手。个人 Mac 只保留开发用途；公司服务部署、手机 HTTPS 配网和验收通过后，运行不依赖这台 Mac。

| 文件 | 用途 |
| --- | --- |
| [整体技术方案](../docs/技术方案.md) | 架构、接口、数据、状态、异常规则与当前限制 |
| [后台服务模板](wechat-channel-backend.service) | 管理渠道审核后台和任务 worker |
| [业务服务模板](wechat-channel-business.service) | 管理只读模拟 MCP 服务 |
| [Nginx 模板](nginx.conf.example) | 同机 HTTPS 入口 |
| [环境检查](../backend/scripts/check_host.py) | 只读检查版本及默认端口 |
| [验收记录](../backend/VALIDATION.md) | 本机已验证结果，不能替代 ECS 验收 |

Hermes 使用 ECS 已有宿主机安装，沿用公司的服务维护方式。它原有的 Docker 命令执行设置不在本次改动范围；两个项目服务同样运行在宿主机。`backend/manage.py` 是 Mac 联调工具，不用它接管或停止公司现有 Hermes。

按“确认参数 → 准备目录和依赖 → 专用配置 → 服务与工具核验 → HTTPS → 手机切换 → 验收”执行。未确认的 Hermes 接口兼容性需要部署人员核实后再继续，不以端口连通替代核验。

## 先确认现有 Hermes，暂不修改或升级

在仓库目录，以当前运行 Hermes 的 Linux 用户执行：

```sh
python3 backend/scripts/check_host.py
```

脚本仅输出 OS、Python、Hermes/uv 版本，以及 8643/8650/8660 是否监听。它不读取密钥、改配置、升级软件或启停服务。端口开放不代表它一定是可用的 Hermes API；还需要确认现有 HTTP API 地址、鉴权方式及专用渠道配置。

适配器当前验证过的版本为 Hermes v0.22.5（bf0203a794a0）。它依赖 `/v1/runs`、运行查询/停止/事件、会话工具记录和持久化幂等能力。另一个版本或已有共享 API 不应只改地址就直接启用：需先核对上述接口、渠道工具白名单及独立会话行为。不得把共享智能体的终端/文件等权限直接继承给群问题。

现有联调采用独立 `channel-bot` profile，仅允许 `query_order` 和 `query_trace`。**以下初始化步骤仅适用于确认独立 profile/API 方案后**；不会由部署模板自动执行，也不要覆盖公司已有同名 profile、默认配置或现有端口。

## 部署参数表

先记录实际值，以下域名和用户名都是占位，不可直接使用。

| 参数 | 当前约定 / 待填写项 |
| --- | --- |
| 系统 | Ubuntu 22.04.5 LTS |
| 代码版本 | 本次文档随附提交；部署时记录 `git rev-parse HEAD`，不要无记录地跟随分支更新 |
| 域名与证书 | 待申请；示例 `https://channel-bot.example.com`，必须能从办公网络访问 |
| Hermes 用户与用户组 | 待填写；后文命令中的 `DEPLOY_USER`、`DEPLOY_GROUP` 和模板 `CHANGE_ME_HERMES_USER` 要统一 |
| Hermes 版本 / API | 待确认；开发实测 v0.22.5，默认 API `http://127.0.0.1:8643` |
| 专用 profile | 全新 `channel-bot`；已有同名配置时不能覆盖，应先核查并调整初始化方案 |
| 代码 / 数据目录 | `/opt/wechat-android-poc` / `/var/lib/wechat-channel` |
| 模型 | 当前初始化支持 DeepSeek；公司提供可用模型配置及独立凭证 |
| 业务 / 群范围 | 模拟数据、`demo-channel-a`、`测试1` / `jarvis`，暂不改为真实业务群 |
| 维护与审核 | 指定服务维护者和一名审核者；当前不是多人账号系统 |

## 需要准备的信息

- 小写域名和 HTTPS 证书，办公手机与审核电脑都能解析并访问该域名。
- 手机须信任完整证书链；公司内部 CA 需按公司正常设备管理方式安装。代码不跳过证书/主机名校验。
- Hermes 的运行用户、版本、已开启的 API 地址、当前专用 profile 的配置情况。
- ECS 出站可访问选定模型服务。当前代码配置的是 DeepSeek；接真实订单接口是后续单独一步。
- 端口安排：入口 443；本方案后台 8660、模拟工具 8650、Hermes API 8643 均只监听 127.0.0.1。已有占用先核实服务，不关闭别人的进程。

## 获取代码和准备目录

部署人员使用自己的 GitHub 权限或公司受控发布包取得私有仓库代码。示例首次部署命令如下；先将用户和组替换为上表实际值，不在已有安装目录重新克隆：

```sh
sudo install -d -o DEPLOY_USER -g DEPLOY_GROUP -m 0750 /opt/wechat-android-poc
sudo install -d -o DEPLOY_USER -g DEPLOY_GROUP -m 0700 /var/lib/wechat-channel
# 以下切换到 DEPLOY_USER 执行；不要用 root 初始化 Hermes profile
# 目标代码目录必须为空，已有仓库时按公司版本发布流程处理
git clone https://github.com/chenhaitao888/wechat-android-poc.git /opt/wechat-android-poc
cd /opt/wechat-android-poc
git rev-parse HEAD
python3 backend/scripts/check_host.py
```

取得指定版本后再继续。若 `uv` 不可用，由部署人员通过公司的软件安装方式准备；本文不自动安装、升级或替换现有 Hermes。无需复制个人 Mac 的 `.local`、Hermes 配置、数据库或密钥到 ECS。

## 目录和运行用户

模板使用 `/opt/wechat-android-poc/backend` 存放代码和 `.venv`，`/var/lib/wechat-channel` 存放配置、SQLite 和核验记录。数据目录由服务运行用户拥有，权限 0700；配置和凭证为 0600。该用户必须能读取独立 Hermes profile；通常选当前运行 Hermes 的用户。

`wechat-channel-*.service` 中的 `CHANGE_ME_HERMES_USER` 必须替换成该账户。若使用其他目录，需要同步替换 WorkingDirectory、ExecStart、CHANNEL_DATA_DIR、ReadWritePaths。不要直接启用未替换的模板。

Ubuntu 22.04 自带 Python 版本不满足本项目的 Python >=3.11；可用已安装的 uv 准备项目独立环境，不修改系统 Python：

```sh
cd /opt/wechat-android-poc/backend
uv sync --frozen --python 3.12
```

## 专用配置准备（待 Hermes 接口确认后）

若确认沿用本机已验证的独立 profile 方式，先由 Hermes 维护者创建全新 profile：

```sh
hermes profile create channel-bot --no-skills --no-alias
```

再在后台目录初始化，域名用实际申请值替换：

```sh
CHANNEL_DATA_DIR=/var/lib/wechat-channel .venv/bin/python configure.py \
  --public-url https://channel-bot.example.com
```

默认仅复制当前 Hermes 默认配置里的 DeepSeek 模型设置和对应密钥到新 profile；不复制历史会话或个人技能。如果服务器按文件提供独立模型凭证，可追加 `--key-file /受控目录/deepseek-key.txt --model deepseek-v4-pro`。脚本不会打印凭证，已有后台配置或非全新的 profile 会拒绝覆盖。

配置生成独立后台 ID、设备 ID、设备凭证、审核凭证和业务工具凭证。`settings.json` 中记录的 profile 必须是该独立配置的真实路径。若已有 API 部署不采用这个 profile 方式，先适配并核验，勿直接执行这组初始化命令。

## 启动顺序和核验

先在模板副本中替换运行账户与路径，再安装到系统目录。以下 `cp` 命令从仓库根目录执行；`systemctl` 和 `journalctl` 不依赖当前目录。

```sh
cd /opt/wechat-android-poc
sudo cp deploy/wechat-channel-business.service deploy/wechat-channel-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start wechat-channel-business
sudo systemctl status wechat-channel-business
```

随后由 Hermes 维护者启动已确认的专用渠道 HTTP API。对于本文已验证的 v0.22.5 独立 profile，初始化生成了 `gateway.standalone: true`，可先在另一个终端、以同一运行用户进行前台验证：

```sh
hermes -p channel-bot gateway run
```

这条命令只适用于已经核对版本、profile、端口且未运行重复实例的环境。长期运行由公司已有 Hermes 维护方式托管，模板不创建 Hermes 系统服务，也不修改默认助手。已有 API 采用不同部署方式时，先确认其渠道隔离和接口契约，不启动第二个冲突实例。

在后台目录，以相同 Linux 用户执行实际工具核验：

```sh
cd /opt/wechat-android-poc/backend
CHANNEL_DATA_DIR=/var/lib/wechat-channel .venv/bin/python -m scripts.verify_profile
```

实际工具必须只有两个渠道只读工具。报告保存在数据目录，配置指纹不匹配时后台停止提交新任务。核验失败先检查专用 profile、MCP 凭证、Hermes 安装及接口，不绕过检查。

核验通过再启动后台，检查状态：

```sh
sudo systemctl start wechat-channel-backend
sudo systemctl status wechat-channel-business wechat-channel-backend
curl --fail --silent --show-error http://127.0.0.1:8660/health
journalctl -u wechat-channel-backend -u wechat-channel-business --since today
# 确认正常后启用两个项目服务的自启动
sudo systemctl enable wechat-channel-business wechat-channel-backend
```

`status=running` 仅表示后台 HTTP 服务在运行；还须检查 `worker` 状态并完成模拟提问。模型凭证错误、工具不可用等问题不能只凭 HTTP 200 排除。

两个项目服务异常退出会有限重启，60 秒内超过 3 次失败则需检查原因。修复后由维护者执行 `systemctl reset-failed` 再启动对应服务。Hermes 的启动与开机恢复另外按公司维护方式确认。

## HTTPS 入口和审核页面

`nginx.conf.example` 提供宿主机 Nginx 配置。替换域名、证书路径后，先执行 `nginx -t` 再按公司流程加载配置。保留原 Host，代理设置 `X-Forwarded-Proto: https`；后台只信任来自同机回环地址的该标记，并且校验配置中的精确域名和 Origin。

如果公司网关统一管理证书，应按实际网关拓扑调整，不直接放宽 Host/Origin 校验或对办公网开放内部服务端口。只向受控办公网络开放入口 443。

域名配置必须为小写 HTTPS origin，如 `https://channel-bot.example.com`，不附加路径、尾斜杠、查询参数或账号信息。当前手机不支持用普通 HTTP 内网 IP 替代域名；不要通过关闭证书验证来处理连接问题。

在服务器和办公审核电脑分别检查实际域名的 `/health`，再打开域名首页登录。手机端还需实际执行配网探测，电脑可访问不能替代安卓证书和网络验证。

审核凭证在 `/var/lib/wechat-channel/reviewer-key.txt`，通过公司受控方式交给审核者，在网页输入。它与设备凭证不同。当前是单审核人试点，尚不是多人账号系统。

## 手机首次配网及从 Mac 切换

服务器准备好后，在 ECS 后台目录导出**仅含设备凭证**的文件：

```sh
CHANNEL_DATA_DIR=/var/lib/wechat-channel .venv/bin/python -m scripts.export_phone_config \
  --output /var/lib/wechat-channel/phone-config.json
```

通过受控文件传输把该文件交给维护手机的电脑，不放入 Git。导出文件已存在时拒绝覆盖。配置包含服务器身份，手机上不同后台使用不同队列文件。

切换前先处理旧后台待审核/待发任务；它们不会迁移到新服务器。手机停止、STOP 存在且无 watch.lock，再通过 USB 进行这一次维护。维护电脑需要同版本仓库、adb 和后台 Python 依赖；传入 `--config-file` 时不需要复制 ECS 的完整后台配置，也不需要在该电脑启动后台。以下在维护电脑执行：

```sh
cd backend
.venv/bin/python -m scripts.provision_phone --serial 手机序列号 \
  --config-file /受控目录/phone-config.json --switch-backend
```

- 脚本只安装和探测连接，不启动机器人，也不发送群消息。
- 必须显式给出 `--switch-backend` 才能替换不同配置；有问题待上报或结果待回报/核查时拒绝切换。
- 先验证 HTTPS、设备凭证及后台 ID，再保存新配置。失败保留原配置；旧配置归档、旧队列和微信去重历史保留在应用私有目录，不清空。
- 共享存储上的暂存凭证在操作结束时移除。不同后台不复用任务队列；域名换到另一个后台也必须使用新后台的导出文件。
- 这是给已安装 AutoX 和控件辅助的测试手机更新脚本与配置，不是全新手机的 APK 安装器。
- 配置时需保持 USB；探测通过后可拔线，在面板点“开始智能体联调（30分钟）”，用办公网络运行。手机仍需解锁并保持微信聊天列表可见。

## 部署后验收清单

下面由部署人员逐项记录日期、代码版本、任务编号及结果。每条需要人工通过的草稿均在网页明确操作；不使用自动审批脚本替代真实群验收。

- [ ] 两个 systemd 服务正常；专用 Hermes 由公司方式托管，实际工具核验通过。
- [ ] 办公电脑和手机能访问域名、信任证书；后台显示网络模式，内部端口仍只监听回环。
- [ ] 网页模拟查询 A123 产生两项模拟依据和字段草稿；网页来源的审批不会发群。
- [ ] 手机切换成功，旧配置与队列保留；拔掉 USB 后面板启动并保持微信列表可见。
- [ ] 另一账号在测试1真正 @jarvis，问一个单订单问题。后台原文与群内问题一致，来源为手机实收。
- [ ] 未审批时群里不收到答案；审批后接收端确认收到，后台记录唯一发件项与观察结果。
- [ ] 测试无 @ 的普通消息和仅粘贴 @ 的文字，确认不产生自动回复。
- [ ] 在未发送阶段分别测试断网恢复、项目服务重启；核对原事件/任务、没有意外补发或重复创建。
- [ ] 若出现发送结果不明，停止并人工核对群消息和同次尝试记录；不通过反复点击通过或清空队列验证重发。
- [ ] 完成本轮自动停止检查，再安排跨夜等后续观察；目前不把 30 分钟上限改成全天。

复用问题时可能生成相同答案；如果屏幕中已有相同答案，手机会停止核查，这是当前边界，不应清空历史绕过。验收记录要区分“气泡可见”和“接收端确认收到”。

没有上述公司网络结果前，不扩大到真实渠道群或全天运行。接公司真实订单接口还需按技术方案扩展业务适配及依据校验，并另行验收；本交付仍为模拟数据试点。

## 备份、停止与回退

数据目录与独立 Hermes profile 应按公司备份策略保存。一致备份顺序：手机停止并核对未完成投递 → 停止两个项目服务和专用渠道 API → 备份 `/var/lib/wechat-channel` 与该专用 profile → 按“业务服务、Hermes、核验、后台”的顺序恢复。不能停止公司其他用途的共享助手。

SQLite 运行中不能只复制主数据库文件而忽略 WAL。备份含凭证和会话，按私有数据保管；恢复备份不代表允许重发已有答案。

停止项目服务的命令：

```sh
sudo systemctl stop wechat-channel-backend wechat-channel-business
```

如需要取消这次试点，由维护者停手机和专用渠道 API，再禁用这两个项目服务，并按公司流程撤下对应域名入口；保留数据用于核对，不删除公司已有 Hermes 安装或配置。

代码回退应使用已记录的旧版本并先核对数据格式兼容性。不要简单恢复旧数据库再开手机：旧快照可能缺失已经发送的记录，必须结合实际群消息核对待发项和手机队列。

若手机要从 ECS 切回旧后台，仍须先停止、处理未完成投递、验证目标后台，再用该后台导出的配置显式 `--switch-backend`。切回个人 Mac 意味着重新依赖 Mac 服务和 USB；不是公司试点默认恢复方案。

## 配置依据

- [Nginx 代理头配置](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [systemd 服务重启语义](https://www.freedesktop.org/software/systemd/man/249/systemd.service.html)

当前验证：应用回归 44 项、手机端回归 107 项通过。宿主机 systemd/Nginx 模板尚未在目标 ECS 启动；域名、证书和 ECS Hermes API 均待确认。手机尚未切换，现有 Mac 配置未修改。
