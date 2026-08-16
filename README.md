# dsh-ocgo-lite

**OpenCode Go 用量常驻条** — DeepSeek Harness 插件。

聊天输入框下方（composer dock）**常驻展开**显示 OpenCode Go 套餐余量、token 消耗与花费，零外部依赖。

<p align="center">
  <img src="screenshots/overview.png" alt="常驻条总览" width="700">
</p>

## ✨ 功能

### GO：账户卡片

点击弹出账户卡片：登录状态、套餐、配额概览、API Key 掩码 + **一键复制**（复制成功有 toast 提示）。

<p align="center">
  <img src="screenshots/go-account.png" alt="GO 账户卡片" width="360">
</p>

### 滚动 / 周 / 月：套餐配额

官方配额百分比圆环（健康色：蓝/黄/红），点击弹出三窗口进度条 + 重置倒计时。

<p align="center">
  <img src="screenshots/quota.png" alt="配额详情" width="360">
</p>

### 范围：全部 / 本次会话

点击切换统计范围——**全部**（所有 DSH 会话合计）/ **本次会话**（仅当前聊天）；切到本次会话时若只有 1 个模型自动选中该模型。每个会话的「范围 + 模型」选择会被**记忆**，切走再切回原样恢复。

<p align="center">
  <img src="screenshots/scope.png" alt="范围选择" width="360">
</p>

### 模型：按模型联动

点击弹出模型选择器——范围=本次会话时只列出本次会话用过的模型；选中后状态条 token/花费联动显示该模型（范围+模型双层联动）。

<p align="center">
  <img src="screenshots/model.png" alt="模型选择" width="360">
</p>

### token：消耗明细

完整数字 + 详情卡片（输入/输出/推理/缓存读/写 + 按模型分组明细，标题随范围显示「总消耗 token / 本次会话总消耗」）；选中模型时只显示该模型口径。

<p align="center">
  <img src="screenshots/token.png" alt="token 详情" width="360">
</p>

### 花费：金额排行

详情卡片：累计金额 + 按模型花费排行（占比条 + 各模型官方定价，随范围/模型联动）。

<p align="center">
  <img src="screenshots/money.png" alt="花费详情" width="360">
</p>

- 点击页面空白处关闭详情卡片
- 30 秒自动刷新（无感，不闪 loading）
- **实时更新**：直读会话日志文件（多帧 zstd 解压 + JSONL 行解析，秒级）
- **会话配置记忆**：每个会话独立记住自己的「范围 + 模型」选择——切到其他会话再切回来，配置原样恢复，互不影响
- 切换会话立即显示（前端共享缓存）
- 复制成功有 toast 弹窗提示

## 🗄️ 数据来源与口径

| 数据 | 来源 | 口径 |
|---|---|---|
| **配额余量** | 官方 `https://opencode.ai/zen/go/v1/usage`（Bearer auth.json key） | **账户级**（含其他设备/软件），不受范围切换影响 |
| **token / 花费** | DSH 会话事件（`assistant/message` 的 usage，过滤 opencode-go provider） | **仅 DSH 会话**（不含 opencode CLI 等），范围=全部/本次会话 |
| **金额** | 按官方定价表估算（per 1M tokens） | 输入 $0.14 / 输出 $0.28 / 缓存读 $0.0028（deepseek-v4-flash） |

### 实时性

- Client 轮询携带 `?live=<sessionId>`，Host **增量直读**会话日志文件
  （帧级流式解压：逐帧 zstd 解压 + 逐行解析，单帧即弃）：只重读 mtime 变化的
  会话（活跃会话），未变化的直接用缓存条目 → 常规轮询仅处理 1~2 个文件
  （几十~几百毫秒），本次会话与全部范围下的模型明细均实时
- **全部范围覆盖所有会话**（不按数量截断，总量完整）；基线为帧级流式全量扫描
  （单文件 ≤ **64MB** 压缩 / 解压文本 ≤ 128MB / 并发 ≤ **2**，逐文件处理即释放，
  峰值内存 ≈ 2 个文件）→ 5 分钟缓存 + in-flight 锁（防重复扫描），冷启动一次性 ~5s

### 定价实时更新

内置官方定价表（`lib/index.js` 的 `PRICING`），启动时与每 24 小时自动抓取
[opencode.ai/docs/go](https://opencode.ai/docs/go) 官方定价表覆盖——**官方改价后自动跟随**，
抓取失败静默回退内置表。API 响应的 `meta.pricingUpdatedAt` 标注最近抓取时间。

## 🚀 安装

### 方式 A：官方 bundle（推荐，随 DSH 启动自动加载）

```sh
# GitHub 直接安装(推荐)
dsh plugin --profile web add github:OK-wx/dsh-ocgo-lite

# 或从源码目录安装
dsh plugin --profile web add <本目录>
dsh --profile web
```

或手动等价操作：把 `dsh-ocgo-lite` 加入 profile `package.json` 的
`dependencies`（`link:<本目录>`）与 `dsh.profile.bundles`，建立 `node_modules` junction，
并应用 `cordis.patch.yml`。

### 方式 B：运行时热装配（免重启）

在 DSH 会话里用注入器（dsh-super-injector）：

```
dev_install_package {"dir": "<本目录>", "profile": "web"}
```

### 方式 C：插件市场

- [dsh.aitreez.com](https://dsh.aitreez.com)（DSH-Plugin Store，GitHub topic 自动收录）
- YELEBAI 插件市场 / dsh-market（收录后可在设置 → 插件市场一键安装）

## 🔌 Host API

- `GET /ocgo-lite/api` — 聚合 JSON（配额 + DSH token/花费 + 按模型/按会话 + 账户掩码）
- `GET /ocgo-lite/api?live=<sessionId>` — 实时通道：增量直读 mtime 变化的会话日志文件
  （未变化的会话用缓存条目），替换后重聚合全局 → 本次会话/全部范围均实时
- `GET /ocgo-lite/key` — 完整 API Key（仅本机同源，供复制）
- 模型工具 `opencode_go_usage` — 对话里直接查询

## 🛠️ 开发

纯手写 ESM bundle 插件，无构建步骤（无需 tsc/tsdown）：

```
lib/index.js   Host：配额抓取 + DSH 会话统计(增量实时/内存保护) + 定价动态更新 + HTTP 路由 + 模型工具
lib/client.js  Client：composer.dock 常驻条 + 详情卡片（Portal 渲染）+ 范围/模型切换 + 会话配置记忆
```

改完 `lib/` 后：`dev_reload_package {"packageName": "dsh-ocgo-lite"}` 热重载（或重启 `dsh web`）。

## 📋 环境要求

- DeepSeek Harness（dsh web）
- 本机已登录 OpenCode Go（`~/.local/share/opencode/auth.json` 含 `opencode-go` key）
- Node.js ≥ 22.5（`fetch`、`node:sqlite`）

## ⚖️ License

MIT
