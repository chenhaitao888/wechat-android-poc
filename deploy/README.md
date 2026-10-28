# ECS 办公网试点：Ubuntu 22.04.5，直接运行在宿主机

目标架构：安卓手机在办公网络，通过已申请的 HTTPS 域名上报问题、领取经人工审核的答案。渠道后台和业务查询服务直接运行在 ECS；Hermes 继续使用宿主机安装。Hermes 原有命令执行环境不属于此次改动范围。

本目录是待环境确认后的部署模板。**当前没有部署到 ECS，也没有把手机切到网络模式。** 现有单群、模拟数据、逐条人工审核、每轮 30 分钟/10 条回复的限制保留。

## 先确认现有 Hermes，暂不修改或升级

在仓库目录，以当前运行 Hermes 的 Linux 用户执行：

```sh
python3 backend/scripts/check_host.py
```

脚本仅输出 OS、Python、Hermes/uv 版本，以及 8643/8650/8660 是否监听。它不读取密钥、改配置、升级软件或启停服务。端口开放不代表它一定是可用的 Hermes API；还需要确认现有 HTTP API 地址、鉴权方式及专用渠道配置。

适配器当前验证过的版本为 Hermes v0.22.5（bf0203a794a0）。它依赖 `/v1/runs`、运行查询/停止/事件、会话工具记录和持久化幂等能力。另一个版本或已有共享 API 不应只改地址就直接启用：需先核对上述接口、渠道工具白名单及独立会话行为。不得把共享智能体的终端/文件等权限直接继承给群问题。

现有联调采用独立 `channel-bot` profile，仅允许 `query_order` 和 `query_trace`。**以下初始化步骤仅适用于确认独立 profile/API 方案后**；不会由部署模板自动执行，也不要覆盖公司已有同名 profile、默认配置或现有端口。

## 需要准备的信息

- 小写域名和 HTTPS 证书，办公手机与审核电脑都能解析并访问该域名。
- 手机须信任完整证书链；公司内部 CA 需按公司正常设备管理方式安装。代码不跳过证书/主机名校验。
- Hermes 的运行用户、版本、已开启的 API 地址、当前专用 profile 的配置情况。
- ECS 出站可访问选定模型服务。当前代码配置的是 DeepSeek；接真实订单接口是后续单独一步。
- 端口安排：入口 443；本方案后台 8660、模拟工具 8650、Hermes API 8643 均只监听 127.0.0.1。已有占用先核实服务，不关闭别人的进程。

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

1. 先启动模拟业务查询服务，确认 127.0.0.1:8650 可用。
2. 由现有 Hermes 的维护方式启动/接入已确认的渠道 HTTP API。模板不管理、重装或升级 Hermes。
3. 在同一 Linux 用户下执行实际工具核验：

   ```sh
   cd /opt/wechat-android-poc/backend
   CHANNEL_DATA_DIR=/var/lib/wechat-channel .venv/bin/python -m scripts.verify_profile
   ```

   实际工具必须只有两个渠道只读工具。验证报告保存在数据目录，指纹不匹配时后台停止提交新任务。

4. 启动渠道后台，检查本机 `/health` 与后台日志。服务启动配置检查失败时先处理原因，不持续重启碰运气。
5. 确认可正常运行后，安装两个 systemd 服务模板并启用自启动。

供维护者操作的 systemd 命令（先替换模板、初始化配置、完成 Hermes 核验）：

```sh
sudo cp deploy/wechat-channel-business.service deploy/wechat-channel-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start wechat-channel-business
# 完成 Hermes API 及工具核验后
sudo systemctl start wechat-channel-backend
sudo systemctl enable wechat-channel-business wechat-channel-backend
sudo systemctl status wechat-channel-business wechat-channel-backend
journalctl -u wechat-channel-backend -u wechat-channel-business --since today
```

两个服务异常退出会有限重启，60 秒内超过 3 次失败则需检查原因并由维护者恢复。后台等待 Hermes 检查时会保留任务状态，不绕过工具核验。

## HTTPS 入口和审核页面

`nginx.conf.example` 提供宿主机 Nginx 配置。替换域名、证书路径后，先执行 `nginx -t` 再按公司流程加载配置。保留原 Host，代理设置 `X-Forwarded-Proto: https`；后台只信任来自同机回环地址的该标记，并且校验配置中的精确域名和 Origin。

如果公司网关统一管理证书，应按实际网关拓扑调整，不直接放宽 Host/Origin 校验或对办公网开放内部服务端口。只向受控办公网络开放入口 443。

审核凭证在 `/var/lib/wechat-channel/reviewer-key.txt`，通过公司受控方式交给审核者，在网页输入。它与设备凭证不同。当前是单审核人试点，尚不是多人账号系统。

## 手机首次配网及从 Mac 切换

服务器准备好后，在 ECS 后台目录导出**仅含设备凭证**的文件：

```sh
CHANNEL_DATA_DIR=/var/lib/wechat-channel .venv/bin/python -m scripts.export_phone_config \
  --output /var/lib/wechat-channel/phone-config.json
```

通过受控文件传输把该文件交给维护手机的电脑，不放入 Git。导出文件已存在时拒绝覆盖。配置包含服务器身份，手机上不同后台使用不同队列文件。

切换前先处理旧后台待审核/待发任务；它们不会迁移到新服务器。手机停止、STOP 存在且无 watch.lock，再通过 USB 进行这一次维护：

```sh
cd backend
.venv/bin/python -m scripts.provision_phone --serial 手机序列号 \
  --config-file /受控目录/phone-config.json --switch-backend
```

- 脚本只安装和探测连接，不启动机器人，也不发送群消息。
- 必须显式给出 `--switch-backend` 才能替换不同配置；有问题待上报或结果待回报/核查时拒绝切换。
- 先验证 HTTPS、设备凭证及后台 ID，再保存新配置。失败保留原配置；旧配置归档、旧队列和微信去重历史保留在应用私有目录，不清空。
- 共享存储上的暂存凭证在操作结束时移除。不同后台不复用任务队列；域名换到另一个后台也必须使用新后台的导出文件。
- 安装时需保持 USB；探测通过后可拔线，用办公网络运行。手机仍需解锁并保持微信聊天列表可见。

## 试点验收和备份

正式让手机切换前，验证证书、域名、审核登录、模拟提问和依据生成。随后在测试1做一条真 @ → 完整问题上报 → 人工审核 → 群内收到的验证，再做断网恢复和服务重启核对，最后延长观察。没有这些结果前，不扩大到真实渠道群或全天运行。

数据目录与独立 Hermes profile 应按公司备份策略保存。最简单的一致备份方式是：手机停止并核对待发状态，停止这两个后台服务和专用渠道 API后，备份 `/var/lib/wechat-channel` 以及该专用 profile，再恢复服务。SQLite 运行中不能只复制主数据库文件而忽略 WAL。备份包含凭证，按私有数据保管；恢复备份不代表允许重发已有答案。

## 配置依据

- [Nginx 代理头配置](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [systemd 服务重启语义](https://www.freedesktop.org/software/systemd/man/249/systemd.service.html)

当前验证：应用回归 44 项、手机端回归 107 项通过。宿主机 systemd/Nginx 模板尚未在目标 ECS 启动；域名、证书和 ECS Hermes API 均待确认。手机尚未切换，现有 Mac 配置未修改。
