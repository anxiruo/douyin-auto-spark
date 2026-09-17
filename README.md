<h1 align="center">🔥 Douyin Auto Spark</h1>

<p align="center">
  <strong>抖音聊天续火脚本 · Playwright 自动化 · GitHub Actions 定时运行</strong>
</p>

<div align="center">
  <img src="assets/readme/banner.png" alt="Douyin Auto Spark Logo">
</div>
<br>

<div align="center">
  <a href="https://github.com/anxiruo/douyin-auto-spark/stargazers"><img src="https://img.shields.io/github/stars/anxiruo/douyin-auto-spark?logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/anxiruo/douyin-auto-spark/actions/workflows/renew-fire.yml"><img src="https://img.shields.io/github/actions/workflow/status/anxiruo/douyin-auto-spark/renew-fire.yml?branch=main&label=%E4%BB%A3%E7%A0%81%E6%A3%80%E6%9F%A5&logo=githubactions" alt="Code Check Status"></a>
  <a href="https://github.com/anxiruo/douyin-auto-spark/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-orange" alt="License"></a>
</div>
<br>

## ✨ 项目简介

本项目是一个基于 **Playwright + TypeScript** 的抖音自动续火脚本。它会携带你配置的抖音 Cookie 打开聊天页，按配置的会话名称依次定位聊天对象，并从 `assets/yiyan.json` 中随机挑选一言发送出去。支持 GitHub Actions 每日自动运行和本地模拟演练。

## 🚀 功能特性

- 🎭 **Cookie 登录** - 通过 `DOUYIN_COOKIE` 注入抖音登录态，无需在脚本中输入账号密码
- 🎯 **多会话发送** - 通过 `DOUYIN_TARGET_NAMES` 配置多个聊天对象
- 👥 **多账号续火** - 可通过 `DOUYIN_ACCOUNTS` 为多个账号分别配置 Cookie、聊天对象和消息模板
- 💬 **随机一言** - 每次从 `assets/yiyan.json` 随机挑选一条 `hitokoto`，默认以 `——「出处」` 的格式附上来源
- 🤖 **定时续火** - GitHub Actions 每天自动执行
- 🛡️ **安全发送** - 会话标题复核、结果验证、当日防重复、并发锁与平台警告熔断

## 🧰 准备工作

在配置本地 `.env` 之前，需要先准备抖音 Cookie 和要发送消息的会话名称。

### 1️⃣ 获取抖音 Cookie

1. 使用 Chrome/Edge 打开 [Cookie-Editor 插件页面](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)，安装 Cookie-Editor。 [（Edge点我）](https://microsoftedge.microsoft.com/addons/detail/cookieeditor/neaplmfkghagebokkhpjpoebhdledlfi)

2. 打开 [抖音聊天页](https://www.douyin.com/chat)，并登录你的抖音账号。

3. 登录成功后，点击浏览器右上角的 Cookie-Editor 插件图标。

4. 点击 `Export`，选择 `JSON`，复制导出的完整数组内容。

   ![cookie](assets/readme/cookie.png)

导出的内容大概长这样：

```json
[
  {
    "domain": ".douyin.com",
    "expirationDate": 1800175766.87008,
    "hostOnly": false,
    "httpOnly": false,
    "name": "UIFID",
    "path": "/",
    "sameSite": "no_restriction",
    "secure": true,
    "session": false,
    "storeId": null,
    "value": "替换成真实 Cookie 值"
  }
]
```

后面配置 `DOUYIN_COOKIE` 时，需要把整个 JSON 数组填入本机 `.env`。不要提交或分享真实 Cookie。

## 运行方式

> [!IMPORTANT]
> 本地 `.env.example` 默认使用 `DRY_RUN=true`，只检查登录、好友搜索和会话切换。GitHub Actions 定时任务使用仓库 Secrets，并明确设置 `DRY_RUN=false` 执行真实续火。Cookie 只能放在 Secrets 或本机 `.env`，不能提交到代码。

### 🛡️ 本地安全保护

本分支在原有发送流程上增加了以下保护：

* 发送前再次核对右侧会话标题，无法确认目标昵称时立即停止
* 按下 Enter 后同时验证输入框清空和新消息气泡出现，不再把按键动作当作成功
* 发送前记录 `pending`、确认后记录 `sent`；结果不明确时不盲目重发
* 同一账号与好友当天只允许成功发送一次，并阻止两个任务同时运行
* 识别操作频繁、安全验证、滑块与短信验证等提示，命中后立即熔断
* 单次发送人数上限和好友间等待时间可配置

运行状态默认保存在 `data/spark-state.json`，该目录已被 Git 忽略。若出现 `pending`，请先人工检查抖音聊天记录；确认没有发送后，再谨慎删除对应记录。不要在未检查聊天记录的情况下直接删除状态文件。

### ⚙️ GitHub Actions

进入仓库的 `Settings -> Secrets and variables -> Actions`，至少添加以下两个 Repository secrets：

| Secret | 说明 |
|:---|:---|
| `DOUYIN_COOKIE` | Cookie-Editor 导出的完整 Cookie JSON 数组 |
| `DOUYIN_TARGET_NAMES` | 好友备注名 JSON 数组，例如 `["好友备注名"]` |

工作流每天按北京时间 0 点自动运行，也可以在仓库的 `Actions` 页面选择“🚀 续一次火”后手动点击 `Run workflow`。如果抖音要求短信或滑块验证，云端无人值守任务会安全停止，需要更新 Cookie 后再次运行。

多账号可改用 `DOUYIN_ACCOUNTS`，其他消息模板和邮件提醒 Secret 均为可选配置。

### 💻 本地运行

#### 1️⃣ 安装依赖

本地调试需要 Node.js 和 pnpm

```bash
pnpm install
```

#### 2️⃣ 配置环境变量

复制 `.env.example` 为 `.env`，并按实际情况修改。Windows PowerShell 使用：

```powershell
Copy-Item .env.example .env
```

核心配置如下：

| 变量 | 必填 | 默认值 | 说明 |
|:---|:---:|:---:|:---|
| `DOUYIN_COOKIE` | ✅ | - | Cookie-Editor 导出的完整 Cookie JSON 数组 |
| `DOUYIN_TARGET_NAMES` | ✅ | - | 要发送消息的好友名称 JSON 数组 |
| `DOUYIN_ACCOUNTS` | ❌ | - | 多账号配置，配置后会无视单账号配置，详情见下方「👥 多账号配置」 |
| `YIYAN_INCLUDE_SOURCE` | ❌ | `true` | 是否携带一言出处，设置为 `false` 时只发送一言正文 |
| `SPARK_MESSAGE_TEMPLATE` | ❌ | - | 自定义火花消息模板，见下方「自定义消息模板」 |
| `PLAYWRIGHT_BROWSER_PATH` | ❌ | - | 本机 Chrome / Chromium / Edge 可执行文件路径，不填则使用 Playwright 默认浏览器 |
| `PLAYWRIGHT_HEADLESS` | ❌ | `true` | 是否使用无头模式 |
| `AUTO_CLOSE` | ❌ | `true` | 发送完成后是否自动关闭浏览器 |
| `DRY_RUN` | ❌ | `true` | `true` 时走完整流程但不发送；确认无误后才在本机显式设为 `false` |
| `SPARK_STATE_PATH` | ❌ | `data/spark-state.json` | 当日防重复与待确认状态文件 |
| `MAX_SENDS_PER_RUN` | ❌ | `10` | 单次运行真实发送人数上限 |
| `SEND_GAP_MIN_SECONDS` | ❌ | `8` | 好友之间最短等待秒数 |
| `SEND_GAP_MAX_SECONDS` | ❌ | `15` | 好友之间最长等待秒数 |

#### 3️⃣ 启动项目

```bash
pnpm dev
```

Windows 也可以运行：

```powershell
.\scripts\run-local.ps1
```

首次务必保持 `DRY_RUN=true` 与 `PLAYWRIGHT_HEADLESS=false`，观察浏览器是否打开了正确的好友会话。模拟演练通过后，先只配置一个测试好友，再把 `DRY_RUN` 改成 `false` 完成人工监督下的单次发送。

脚本会打开 `https://www.douyin.com/chat`，依次定位配置中的好友并发送随机一言。

## 👥 多账号配置

需要为多个抖音账号续火时，将下面的 JSON 保存为本机 `.env` 中的 `DOUYIN_ACCOUNTS`。每个账号的 `cookie` 都要替换成 Cookie-Editor 导出的完整数组，不要提交到 Git。

```json
[
  {
    "name": "账号1",
    "cookie": [
      {
        "domain": ".douyin.com",
        "expirationDate": 1800175766.87008,
        "hostOnly": false,
        "httpOnly": false,
        "name": "UIFID",
        "path": "/",
        "sameSite": "no_restriction",
        "secure": true,
        "session": false,
        "storeId": null,
        "value": "账号1的真实 Cookie 值"
      }
    ],
    "targetNames": ["好友A", "好友B"]
  },
  {
    "name": "账号2",
    "cookie": [
      {
        "domain": ".douyin.com",
        "expirationDate": 1800175766.87008,
        "hostOnly": false,
        "httpOnly": false,
        "name": "UIFID",
        "path": "/",
        "sameSite": "no_restriction",
        "secure": true,
        "session": false,
        "storeId": null,
        "value": "账号2的真实 Cookie 值"
      }
    ],
    "targetNames": ["好友C"],
    "messageTemplate": "{{friend}}，{{account}} 今天来续火啦\\n{{date}} {{weekday}}"
  }
]
```

每个账号对象支持的字段：

| 字段 | 必填 | 说明 |
|:---|:---:|:---|
| `name` | ✅ | 账号标识，用于日志、错误提示、失败截图和 `{{account}}` 占位符；不同账号不能重名 |
| `cookie` | ✅ | Cookie-Editor 为这个账号导出的完整 JSON 数组 |
| `targetNames` | ✅ | 这个账号需要发送消息的好友名称数组，建议使用抖音备注名 |
| `messageTemplate` | ❌ | 账号独立模板；JSON 字符串中的换行写成 `\n`，未配置时继承全局模板 |

配置 `DOUYIN_ACCOUNTS` 后会优先使用多账号配置。脚本会依次运行各账号，单个账号失败后继续执行其余账号，最后统一报告失败。

## ✉️ 自定义消息模板

配置 `SPARK_MESSAGE_TEMPLATE` 可定义所有账号共用的默认消息内容；账号对象中的 `messageTemplate` 可以覆盖它：

```dotenv
SPARK_MESSAGE_TEMPLATE={{friend}}，今天的火花到账啦🔥\n{{yiyan}}\n——「{{from}}」\n{{date}} {{weekday}}
```

支持的占位符：

| 占位符 | 说明 |
|:---|:---|
| `{{account}}` | 当前账号的配置名称 |
| `{{friend}}` | 好友名 |
| `{{yiyan}}` | 一言正文 |
| `{{from}}` | 一言出处 |
| `{{date}}` | 日期 `yyyy-MM-dd` |
| `{{time}}` | 时间 `HH:mm` |
| `{{weekday}}` | 星期几 |

## 🔨 开发命令

```bash
# 启动脚本
pnpm dev

# TypeScript 类型检查
pnpm typecheck

# 代码格式化
pnpm format
```

## 📂 项目结构

```text
douyin-auto-spark/
├── .github/workflows/
│   └── renew-fire.yml          # 🚀 GitHub Actions 每日续火任务
├── assets/
│   ├── readme/                 # 🖼️ README 资源
│   └── yiyan.json              # 📚 随机消息数据源
├── src/
│   ├── main.ts                 # 🎭 Playwright 自动化入口
│   ├── runtime-state.ts        # 🛡️ 防重复状态与并发锁
│   ├── runtime-state.test.ts   # ✅ 状态与锁测试
│   └── types/
│       ├── douyin-cookie.ts    # 🍪 抖音 Cookie 类型
│       └── yiyan.ts            # 💬 一言数据类型
├── scripts/
│   └── run-local.ps1           # 🪟 Windows 本地启动脚本
├── .env.example                # ⚙️ 环境变量示例
├── .gitignore                  # 🙈 Git 忽略规则
├── .oxfmtrc.jsonc              # 🎨 oxfmt 配置
├── .oxlintrc.jsonc             # 🔍 oxlint 配置
├── LICENSE                     # 📄 GPL v3.0 许可证
├── pnpm-lock.yaml              # 🔒 pnpm 依赖锁文件
├── tsconfig.json               # 🧩 TypeScript 配置
└── package.json                # 📦 项目依赖与脚本
```

## 🛠️ 本地环境

|  环境   | 版本要求 |
|:-------:|:--------:|
| Node.js |   20+    |
|  pnpm   |    11    |

## 🔗 主要依赖

| 依赖 | 用途 |
|:---|:---|
| `playwright` | 自动打开浏览器、注入 Cookie、定位会话并发送消息 |
| `dotenv` | 读取本地 `.env` 配置 |
| `tsx` | 本地通过 `pnpm dev` 运行 TypeScript 脚本 |
| `typescript` | 执行 `pnpm typecheck` 类型检查 |
| `oxlint` / `oxfmt` | 代码检查与格式化 |

## 📄 许可证

本项目采用 [GPL v3.0](LICENSE) 开源许可证。
