# LibreTV 安卓客户端（开源版）

把 [LibreTV](https://github.com/LibreSpark/LibreTV) 装进手机的一个壳：内置 Node 运行时，App 自己在本机 `127.0.0.1` 上跑起官方 standalone 服务，再套一层为移动触屏深度重构的极光玻璃界面与播放器交互。

**本开源版严格不含任何内置源。** APK 内不包含任何点播源、直播源清单、私人密钥、用户隐私或外链域名清单（明文白名单仅放行 `127.0.0.1`），所有片源与订阅均由使用者在设备端自行配置。

- 版本：`1.2.17-oss`（`versionCode 29`）
- 包名：`com.libretv.client`
- 支持架构：`arm64-v8a`（Android 5.0+ / API 21，targetSdk 34）
- 开源协议：[AGPL-3.0-or-later](LICENSE)
- 安装包下载：[前往 Releases 下载最新 `LibreTV-1.2.17-oss.apk`](../../releases/latest)（约 32.7 MB，仅 `arm64-v8a`，零内置源）

---

## 一、开源版核心原则

| 项目 | 开源发行版 |
| :--- | :--- |
| 内置点播 / 直播源 | **0 条**（零预设清单、零采集域名白名单） |
| 初始访问密码 | **默认免手输**（设备首次启动用 `SecureRandom` 生成本地 32 位随机串，经 `auto-login.js` 自动登录） |
| 源导出 / 订阅同步 | 支持手机本地 JSON 导入导出、手动管理及 HTTPS 在线订阅 |
| 签名与调试标记 | 正式打包 `android:debuggable="false"`，使用本地生成的 OSS 签名证书完成 v1 / v2 / v3 签名 |

---

## 二、安装与首次启动

```bash
adb install -r LibreTV-1.2.17-oss.apk
```

首次启动流程：

1. `LocalServerService` 前台服务以解压流（支持 XZ 与 gzip）将 `assets/libretv-standalone.bin` 释放到应用私有目录，伴随极光启动进度条显示。
2. 拉起内置 Node 进程（默认监听 `127.0.0.1:8899`，端口占用自动顺延），并带 30 秒健康巡检与通知栏一键停止按钮。
3. 客户端自动完成免密登录进入主界面。
4. 此时处于**零源状态**（搜片提示需至少启用一个点播源属正常现象），在浏览器/应用内「设置 → 源管理」或原生「设置 → 片源」配置源后即可使用。

> **局域网共享提示**
> 默认随机密码仅在本机内存与私有 `SharedPreferences` 内流转，不会记录日志或上传。若需开启「允许同一 Wi-Fi 的其它设备访问本机服务」，请先在「设置 → 连接」填写自定义访问密码并重启服务，否则客户端会自动拦截并提示。

---

## 三、配置片源（三种方式）

1. **网页端手动添加**：登录后打开 **设置 → 源管理 → 添加源**，填写名称与标准 CMS/MacCMS v10 JSON 接口地址并测活勾选。
2. **本机 JSON 导入 / 导出**：通过原生 **设置 → 片源 → 导入或导出片源** 选择包含 `{ "name", "url", "isAdult" }` 数组的 JSON 文件，实现多机迁移。
3. **本机 HTTPS 在线订阅（`OnlineSourceSubscription`）**：支持在设备设置中填入个人 HTTPS 订阅地址（支持手动立即更新，或开启首页每天最多自动同步一次，拉取失败时保留旧条目不清空）。

---

## 四、客户端特性总览

### 4.1 本地服务保活与安全加固

- **前台服务保活（`LocalServerService`）**：独立于 Activity 持有 Node 子进程，切后台不易被系统回收，常驻通知支持停止服务与周期自愈。
- **隐私与网络安全**：Manifest 禁用云备份（`allowBackup="false"`）、默认禁止明文传输（仅 `127.0.0.1` 环回）、覆写 `onReceivedSslError` 拦截异常证书；`LtvBridge` 对 `@JavascriptInterface` 严格校验 `127.0.0.1` 来源及每次导航轮换的随机口令。
- **弱网与切网优化**：`LocalServer.java` 在 Wi-Fi / 5G 切换时优先排列可用公网 DNS，配合 `node-boot.js` 60 秒正向解析缓存、单飞合并与 IPv6 回退。
- **源健康度防误杀（`patch_stability.py`）**：连败阈值放宽至 5 次，冷却梯度封顶 `3m → 10m → 30m`（绝不永久停用）；断网导致有效源全军覆没时自动豁免扣分；搜索后端限制最大并发 8，避免高并发拖死移动热点。

### 4.2 本地 HLS 防盗链反代（`hls-proxy.cjs`）

- 当播放器直连 `.m3u8` 遭遇 `403` 或防盗链拦截时自动切换至 `/api/proxy?ltv_hls=1`，由本地 Node 补齐 `Referer`、`Origin`、`User-Agent` 后转发。
- 自动将相对路径子清单、TS/FMP4 分片、`EXT-X-KEY`、`EXT-X-MAP` 重写经反代访问，并原生支持 `Range` / `206` 断点分片传输与内网地址 SSRF 防护。

### 4.3 生产级触屏播放器、全屏手势与 DLNA 投屏

- **极光舞台与无缝过渡**：`patch_ui_fx.py` 与 `patch_hls.py` 生成 1280×720 极光夜空暗调舞台封面（左下角轻水印避开居中加载动画），起播后 380ms 合成器透明度平滑淡隐；「自动连播已开启」胶囊置于右上角自动淡出。
- **4px 纤细进度条与 32px 热区（`player-touch.js`）**：限制视觉进度轨为 4px 高（按压扩展 6px），同时保留 28–32px 隐形触控命中区；播放/全屏状态在 `<16ms` 内通过 `requestAnimationFrame` 同步。
- **全屏专业手势（`MainActivity.java`）**：
  - `240ms` 单击平滑切换控制条与顶栏胶囊（4 秒静置后顶栏自动柔化至 44% 透明度不抢戏）；
  - 分区双击（`<=260ms`）：左区 `-10s` 快退、中区播放/暂停、右区 `+10s` 快进；
  - 定点长按（`450ms`）触发 `2.0×` 临时倍速，松手恢复记忆倍速；
  - 左右横向拖动将屏幕宽度映射为 `min(duration, 180s)` 精细拖时，左右半屏上下滑动调节亮度与浮点亚步进音量，配合居中玻璃计量 HUD 实时反馈。
- **长剧集与跨终端续播**：剧集 `>= 45` 集时启用 `DocumentFragment` 批量挂载与横向 `scroll-snap` 分段胶囊（`1-50`、`51-100`…）；集成线路切换、IndexedDB 断点续播与 Android 8.0+ 系统画中画（PiP）。
- **DLNA 电视投屏与 4Hz 遥控器（`DlnaCast` / `DlnaHttp`）**：SSDP 自动发现局域网电视（也支持手动填 IP），投屏中提供带 `−30s` / 播放暂停 / `+30s`、4Hz 平滑外推与实时位置同步的跨浏览器玻璃遥控滑块。

### 4.4 Aurora Liquid Glass 极光玻璃界面

- `ui-fx.css` 与 `ui-fx.js` 提供深邃暗夜与冰透浅色双主题，采用 `startViewTransition()` 基于点击坐标执行全屏圆形扩展切换，并完整适配 `prefers-reduced-motion`；播片与全屏态自动暂停背景光影动画以专注视频解码与手势帧率。
- `/watch` 竖屏页播放器支持粘性吸顶与毛玻璃控制栏；原生壳配备滑动流光底栏胶囊、极光顶部加载条、防错位字体放大适配、全量暗色玻璃对话框与可搜索分类日志面板。

---

## 五、从源码自行构建

仓库支持两种开箱即用的纯开源构建方式（均确保产出 **0 内置源 APK**）：

### 方式 A：Linux / macOS（Gradle 完整构建）

```bash
./prepare-tools.sh     # 下载 JDK 17、Android SDK 34 与 Gradle 8.6 到 /tmp
./build-apk.sh         # 自动拉取/补丁 Node 运行时、排除源清单并输出 release 签名 APK
```

说明：若你处在离线环境，可通过环境变量传入本地静态包：
`LIBRETV_STANDALONE_TAR=/path/to/libretv-2.22.0-standalone.tar.gz ./build-apk.sh`

### 方式 B：Windows / Linux / macOS（免 Gradle 纯 Python + Android SDK 构建）

```bash
# 1. 准备 Node ELF 与已打补丁的 XZ 运行包（或复用现有开源原版 APK 的 runtime）
python tools/prepare-node.py

# 2. 直接用 Android SDK (aapt2 / d8 / zipalign / apksigner) + javac 编译并产出纯开源 release APK
python tools/build-oss-apk.py --sdk "<ANDROID_SDK路径>" --out dist/LibreTV-1.2.17-oss.apk
```

也可通过 `--runtime-from-apk <官方oss基础包.apk>` 直接提取第三方 Node/standalone 运行时并现场打补丁、`debuggable=false` 与 v1/v2/v3 签名。

---

## 六、项目目录

```text
libretv-android-oss/
├─ app/src/main/
│  ├─ AndroidManifest.xml
│  ├─ java/com/libretv/client/
│  │  ├─ MainActivity.java              # WebView 宿主、JS 桥、全屏手势、流光底栏、PiP
│  │  ├─ LocalServerService.java        # 前台保活服务与周期健康自愈
│  │  ├─ LocalServer.java               # 运行时解压、DNS 优化、Node 进程管理
│  │  ├─ RuntimeCompression.java        # XZ / gzip 运行时双格式解压识别
│  │  ├─ OnlineSourceSubscription.java  # 设备端 HTTPS 在线源订阅同步
│  │  ├─ DlnaCast.java                  # SSDP 发现与 AVTransport SOAP 投屏控制
│  │  ├─ DlnaHttp.java                  # 动态局域网媒体地址与设备描述交互
│  │  ├─ AppLog.java                    # 分级环形运行日志缓冲
│  │  └─ LogProvider.java               # content:// 私有日志导出
│  ├─ assets/
│  │  ├─ inject.js / auto-login.js      # 页面桥接、随机密串免手输自动登录
│  │  ├─ player-touch.js                # 极光全屏控件、4px 进度条、长选集分段、4Hz 投屏遥控
│  │  ├─ ui-fx.js                       # 全站交互微动效与 View Transitions 主题切换
│  │  ├─ node-boot.js                   # Node 端 60s DNS 解析缓存与 IPv6 兜底
│  │  ├─ import-sources.js / export-sources.js / diagnose.js
│  │  └─ cacert.bundle                  # CA 根证书包
│  ├─ res/                              # 极光方案 3 自适应桌面图标、暗色主题、仅 127.0.0.1 明文配置
│  └─ jniLibs/arm64-v8a/                # 构建期生成的 Node ELF（.gitignore 忽略）
├─ tools/
│  ├─ prepare-node.py                   # 下载/准备 Node ELF 并调用 patch_hls 应用开源补丁
│  ├─ build-oss-apk.py                  # 免 Gradle 跨平台零源 release 构建脚本
│  ├─ patch_hls.py / hls-proxy.cjs      # HLS 403 本地反代与构建期补丁调度
│  ├─ patch_player.py / patch_stability.py / patch_ui_fx.py
│  ├─ ui-fx.css / ui-fx.js              # Aurora Liquid Glass 样式与脚本
│  └─ brand-icon-512.png                # 去 EXIF 纯净极光品牌图标母版
├─ prepare-tools.sh / build-apk.sh
└─ LICENSE                              # AGPL-3.0-or-later
```

---

## 七、已知限制与合规声明

- **仅支持 arm64-v8a**：内置 Node 运行时为 aarch64 Android ELF；x86 / 32 位 ARM 仅可关闭本地服务、作为外部浏览器壳使用。
- **DLNA 依赖同网段组播**：若路由器/企业 Wi-Fi 开启 AP 隔离导致搜不到电视，可使用手动输入电视 IP / 系统屏幕镜像。
- **国产 ROM 后台限制**：建议在系统设置允许自启动与无限制后台电池策略，以保证前台服务在切后台或锁屏投屏时稳定运行。
- **许可证（AGPL-3.0-or-later）**：
  - 上游客户端：<https://github.com/hzl790209/libretv-android-oss>（AGPL-3.0-or-later）
  - 上游服务端：<https://github.com/LibreSpark/LibreTV>（AGPL-3.0）
  - 内置运行时：[Node.js](https://nodejs.org)（MIT，取自 Termux 构建）、[XZ for Java](https://tukaani.org/xz/java.html)（0BSD / Public Domain）
  - 本项目仅提供开源客户端与播放器交互改造，**不包含、不托管、不分发任何视频内容或采集源接口**，对外分发二进制时须按 AGPL-3.0-or-later 附带许可证与完整对应源码。
