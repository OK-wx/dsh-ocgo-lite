# dsh-ocgo-lite

**OpenCode Go 用量常驻条** — DeepSeek Harness 插件。

聊天输入框下方（composer dock）**常驻展开**显示 OpenCode Go 套餐余量、token 消耗与花费，零外部依赖。

```
[GO:]  滚动：◯5%  周：◯7%  月：◯3%  范围：本次会话  模型：deepseek-v4-flash  token：58,234  花费：$0.04
```

## ✨ 功能

| 区块 | 交互 |
|---|---|
| **GO:** | 点击弹出账户卡片（登录状态、套餐、配额概览、API Key 掩码 + 一键复制） |
| **滚动 / 周 / 月（圆环）** | 官方配额百分比圆环（健康色：蓝/黄/红），点击弹出三窗口进度条 + 重置倒计时 |
| **范围：** | 点击切换统计范围——**全部**（所有 DSH 会话合计）/ **本次会话**（仅当前聊天）；切到本次会话时若只有 1 个模型自动选中该模型 |
| **模型：** | 点击弹出模型选择器——范围=本次会话时只列出本次会话用过的模型；选中后状态条 token/花费联动（范围+模型双层联动） |
| **token** | 完整数字 + 详情卡片（输入/输出/推理/缓存读/写 + 按模型分组明细，标题随范围显示「总消耗 token / 本次会话总消耗」） |
| **花费** | 详情卡片：累计金额 + 按模型花费排行（占比条 + 各模型官方定价，随范围联动） |

- 点击页面空白处关闭详情卡片
- 30 秒自动刷新（无感，不闪 loading）
- **本次会话范围实时更新**（直读会话文件，秒级；全部范围走 5 分钟缓存）
- 切换会话立即显示（前端共享缓存）
- 复制成功有 toast 弹窗提示

## 🗄️ 数据来源与口径

| 数据 | 来源 | 口径 |
|---|---|---|
| **配额余量** | 官方 `https://opencode.ai/zen/go/v1/usage`（Bearer auth.json key） | **账户级**（含其他设备/软件），不受范围切换影响 |
| **token / 花费** | DSH 会话事件（`assistant/message` 的 usage，过滤 opencode-go provider） | **仅 DSH 会话**（不含 opencode CLI 等），范围=全部/本次会话 |
| **金额** | 按官方定价表估算（per 1M tokens） | 输入 $0.14 / 输出 $0.28 / 缓存读 $0.0028（deepseek-v4-flash） |

### 实时性

- **本次会话**：Client 轮询携带 `?live=<sessionId>`，Host 直读该会话日志文件
  （多帧 zstd 解压 + JSONL 行解析，约 1~3 秒），绕过全量扫描缓存 → **实时更新**
- **全部**：全量扫描（并发 24 读会话）+ 5 分钟缓存 + in-flight 锁（防重复扫描）；
  实时会话会同步反映在全部口径中

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

## 🔌 Host API

- `GET /ocgo-lite/api` — 聚合 JSON（配额 + DSH token/花费 + 按模型/按会话 + 账户掩码）
- `GET /ocgo-lite/api?live=<sessionId>` — 实时通道：只重读指定会话（秒级），替换缓存条目后重聚合全局
- `GET /ocgo-lite/key` — 完整 API Key（仅本机同源，供复制）
- 模型工具 `opencode_go_usage` — 对话里直接查询

## 🛠️ 开发

纯手写 ESM bundle 插件，无构建步骤（无需 tsc/tsdown）：

```
lib/index.js   Host：配额抓取 + DSH 会话统计 + 定价动态更新 + HTTP 路由 + 模型工具
lib/client.js  Client：composer.dock 常驻条 + 详情卡片（Portal 渲染）+ 模型选择
```

改完 `lib/` 后：`dev_reload_package {"packageName": "dsh-ocgo-lite"}` 热重载。

## 📋 环境要求

- DeepSeek Harness（dsh web）
- 本机已登录 OpenCode Go（`~/.local/share/opencode/auth.json` 含 `opencode-go` key）
- Node.js ≥ 22.5（`fetch`、`node:sqlite`）

## ⚖️ License

MIT
