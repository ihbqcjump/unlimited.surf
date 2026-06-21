# Cloudflare 部署完全指南 / Complete Deployment Guide

中文 | [English](#english-section)

本文档是本项目的完整部署参考手册。无论你是第一次使用 Cloudflare Workers，还是想深入了解本项目与原版 `eooce/transfer-api` 的差异，都可以在这里找到答案。

---

## 目录

1. [项目概述](#1-项目概述)
2. [与原版的关键差异（必读）](#2-与原版的关键差异必读)
3. [架构原理](#3-架构原理)
4. [前置条件](#4-前置条件)
5. [获取代码](#5-获取代码)
6. [wrangler.toml 配置详解](#6-wranglertoml-配置详解)
7. [部署方式一：Wrangler CLI 本地部署（推荐）](#7-部署方式一wrangler-cli-本地部署推荐)
8. [部署方式二：GitHub + Cloudflare 自动部署](#8-部署方式二github--cloudflare-自动部署)
9. [部署方式三：Cloudflare Dashboard 手动上传](#9-部署方式三cloudflare-dashboard-手动上传)
10. [Secrets 密钥配置（所有部署方式通用）](#10-secrets-密钥配置所有部署方式通用)
11. [自定义域名绑定](#11-自定义域名绑定)
12. [部署后验证](#12-部署后验证)
13. [Tool Calling 使用指南（核心增强功能）](#13-tool-calling-使用指南核心增强功能)
14. [客户端接入示例](#14-客户端接入示例)
15. [API 端点完整列表](#15-api-端点完整列表)
16. [密钥优先级规则详解](#16-密钥优先级规则详解)
17. [更新 Worker](#17-更新-worker)
18. [常见问题排查](#18-常见问题排查)
19. [安全最佳实践](#19-安全最佳实践)
20. [与原版逐项对比表](#20-与原版逐项对比表)

---

## 1. 项目概述

本项目是一个 Cloudflare Worker 适配器，将 `https://unlimited.surf` 的内部 API 转换为标准的 OpenAI 兼容接口和 Anthropic 兼容接口。部署后你将获得一个可公开访问的 API 端点，任何支持 OpenAI 或 Anthropic API 格式的客户端（SDK、IDE 插件、AI Agent 等）都可以直接使用。

**核心功能**：

- OpenAI 兼容：`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/files`
- Anthropic 兼容：`/v1/messages`、`/anthropic/v1/messages`、`/v1/models`
- 原始 API 透传：`/api/*` 直接转发到 unlimited.surf
- **Tool Calling 支持**（本项目独有增强）：完整的 Anthropic Messages API 工具调用

**项目地址**：`https://github.com/ihbqcjump/unlimited.surf`

---

## 2. 与原版的关键差异（必读）

本项目基于 [eooce/transfer-api](https://github.com/eooce/transfer-api) 改造，是**独立维护的增强版本**。以下是对比原版的完整差异清单：

### 2.1 代码层面

| 差异项 | 原版 (eooce/transfer-api) | 本项目 |
|--------|--------------------------|--------|
| Anthropic Tool Calling | 不支持。`tools` 被序列化为纯文本，模型无法产生 `tool_use` 响应 | **完整支持**。有 `tools` 时自动走直连代理，保留完整 Anthropic 协议 |
| `anthropicMessages()` 函数 | 所有请求统一走 `/api/chat` 文本转换 | 检测 `body.tools`，有 tools 时分流到 `proxyAnthropicMessages()` |
| `proxyAnthropicMessages()` | 不存在 | **新增**。将完整请求体（含 tools、messages、system）代理到上游 `/v1/messages` |
| `proxyAnthropicStream()` | 不存在 | **新增**。流式 SSE 直连代理，透传上游所有 SSE 事件（含 `input_json_delta`） |
| 默认模型 | `gateway-gpt-5-5` (OpenAI), `claude-opus-4-7-20260101` (Anthropic) | 相同，但可通过 `wrangler.toml` 的 `[vars]` 修改 |

### 2.2 配置层面

| 差异项 | 原版 | 本项目 |
|--------|------|--------|
| `wrangler.toml` | 仅基础三项（name、main、compatibility_date） | 增加 `[vars]` 环境变量、`routes` 域名模板、完整密钥配置注释 |
| 自定义域名 | 不支持（需手动在 Dashboard 配置） | `routes` 模板 + 部署文档说明 |
| 密钥配置说明 | 无 | 完整的优先级规则和配置建议 |
| 部署文档 | 简略 | 本文件（完整部署指南） |

### 2.3 部署层面

| 差异项 | 原版 | 本项目 |
|--------|------|--------|
| 无 tools 请求 | 走 `/api/chat` 文本转换 | 相同（完全兼容） |
| 有 tools 请求 | 走 `/api/chat`（**丢失 tool calling**） | 走 `/v1/messages` 直连代理（**保留完整 tool calling**） |
| 上游端点选择 | 始终使用 `/api/chat` | 根据是否有 tools 自动选择 `/api/chat` 或 `/v1/messages` |
| `anthropic-version` 头 | 不透传 | 透传到上游（直连路径），默认 `2023-06-01` |
| `anthropic-beta` 头 | 不透传 | 透传到上游（直连路径） |

**重要**：如果你不需要 Tool Calling 功能，本项目与原版行为完全一致，可以无缝替换。

---

## 3. 架构原理

```
客户端 (SDK/Agent/IDE)
    │
    │  POST /v1/messages  (带 tools)
    │  POST /v1/chat/completions
    │  GET /v1/models
    │  ...
    ▼
┌───────────────────────────────────┐
│  Cloudflare Worker (本项目)        │
│                                   │
│  1. 验证 WORKER_API_KEY           │
│  2. 路由分发                       │
│  3. 格式转换 / 直连代理            │
└──────────┬────────────────────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌──────────┐ ┌──────────────┐
│ /api/*   │ │ /v1/messages │
│ (文本转换) │ │ (直连代理)    │
└────┬─────┘ └──────┬───────┘
     │              │
     ▼              ▼
┌───────────────────────────────────┐
│  unlimited.surf 上游服务            │
│                                   │
│  /api/chat     → 简单文本对话      │
│  /api/search   → 联网搜索          │
│  /api/merge    → 多模型合并        │
│  /v1/messages  → 完整 Anthropic API│
│                   (支持 tool_use)  │
└───────────────────────────────────┘
```

**关键路径说明**：

- **无 tools 的 Anthropic 请求**：走原版的文本转换路径，将 `messages` 数组拼接为纯文本，通过 `/api/chat` 发送到上游。
- **有 tools 的 Anthropic 请求**（本项目增强路径）：Worker 检测到 `body.tools` 非空后，将整个请求体原封不动地代理到上游 `/v1/messages`，该端点原生支持 Anthropic 协议的全部特性。
- **OpenAI 请求**：始终走文本转换路径（与原版一致），通过 `/api/chat`、`/api/search`、`/api/merge` 等上游端点。

---

## 4. 前置条件

### 4.1 必需

- **Cloudflare 账户**：注册 [cloudflare.com](https://dash.cloudflare.com/sign-up)，免费计划即可（Workers 免费额度每天 10 万次请求）
- **unlimited.surf API Key**：从 unlimited.surf 获取（格式如 `ua_xxxxxxxx`）
- **Node.js**：版本 18+（推荐使用 LTS 版本）

### 4.2 根据部署方式选择

| 部署方式 | 额外需要 |
|---------|---------|
| Wrangler CLI（推荐） | Wrangler CLI (`npm install -g wrangler`) |
| GitHub 自动部署 | Git + GitHub 账户 |
| Dashboard 手动上传 | 无额外要求 |

### 4.3 可选

- **自定义域名**：需要一个已托管在 Cloudflare 的域名
- **Git**：用于代码版本管理和 GitHub 自动部署

### 4.4 安装 Node.js 和 Wrangler

**Windows (PowerShell)**：

```powershell
# 方法一：通过 winget 安装 Node.js
winget install OpenJS.NodeJS.LTS

# 安装 wrangler
npm install -g wrangler
```

**macOS (Homebrew)**：

```bash
brew install node
npm install -g wrangler
```

**Linux (apt)**：

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g wrangler
```

验证安装：

```bash
node --version   # 应显示 v18.x 或更高
npm --version    # 应显示 9.x 或更高
wrangler --version  # 应显示 3.x 或更高
```

---

## 5. 获取代码

### 5.1 通过 Git 克隆（推荐）

```bash
git clone https://github.com/ihbqcjump/unlimited.surf.git
cd unlimited.surf
npm install
```

### 5.2 直接下载

1. 打开 `https://github.com/ihbqcjump/unlimited.surf`
2. 点击绿色的 `Code` 按钮
3. 选择 `Download ZIP`
4. 解压后进入目录，运行 `npm install`

### 5.3 项目文件结构

```
unlimited.surf/
├── src/
│   └── worker.js          # Worker 核心代码（~1389 行）
├── wrangler.toml          # Cloudflare 部署配置
├── package.json           # npm 配置和脚本
├── .gitignore             # Git 忽略规则
├── README.md              # 项目说明
├── DEPLOY.md              # 本文档
└── repo-backup/           # （不存在于仓库中，仅本地备份时使用）
```

**各文件的作用**：

- **`src/worker.js`**：Worker 的全部逻辑都在这里。搜索 `本仓库` 或 `MODIFIED` 或 `新增函数` 可以快速定位本项目的修改点。
- **`wrangler.toml`**：Cloudflare 的部署配置，包含 Worker 名称、入口文件、环境变量等。
- **`package.json`**：定义了 `dev`（本地开发）、`deploy`（部署）、`check`（语法检查）三个命令。

---

## 6. wrangler.toml 配置详解

这是部署的核心配置文件。以下是每一行的详细说明：

```toml
# Worker 名称，部署后会显示在 Cloudflare Dashboard
# 建议改成容易辨识的名字，如 "my-api-relay"
# 可以在 Dashboard → Workers → 你的 Worker → Settings 中随时改名
name = "unlimited-transfer-api"

# Worker 入口文件（相对于项目根目录）
main = "src/worker.js"

# Cloudflare 运行时兼容日期
# 这个日期决定了 Worker 使用哪个版本的运行时 API
# 通常不需要修改，除非 Cloudflare 发布重大变更
compatibility_date = "2025-11-21"
```

### routes（可选，自定义域名）

```toml
# 取消注释以启用自定义域名绑定
# 前提：你的域名必须已经托管在 Cloudflare
routes = [
  { pattern = "api.example.com", zone_name = "example.com", custom_domain = true }
]
```

| 字段 | 说明 |
|------|------|
| `pattern` | 你希望绑定的域名/子域名，必须是 Cloudflare 管理的域名 |
| `zone_name` | 域名根域（Cloudflare Zone 名称），通常是主域名 |
| `custom_domain` | 设为 `true` 时 Cloudflare 自动处理 DNS 和 SSL |

**不设置 routes 时**：Worker 会使用默认的 `*.workers.dev` 域名（如 `unlimited-transfer-api.你的用户名.workers.dev`），适合测试和一般使用。

### [vars] 环境变量

```toml
[vars]
UPSTREAM_BASE_URL = "https://unlimited.surf"
DEFAULT_MODEL = "gateway-gpt-5-5"
DEFAULT_CLAUDE_MODEL = "claude-opus-4-7-20260101"
```

| 变量 | 作用 | 默认值 | 修改场景 |
|------|------|--------|---------|
| `UPSTREAM_BASE_URL` | 上游 API 地址 | `https://unlimited.surf` | 如果你有自己的 unlimited.surf 镜像 |
| `DEFAULT_MODEL` | OpenAI 兼容接口的默认模型 | `gateway-gpt-5-5` | 想默认使用其他模型时 |
| `DEFAULT_CLAUDE_MODEL` | Anthropic 兼容接口的默认模型 | `claude-opus-4-7-20260101` | 想默认使用其他 Claude 模型时 |

**注意**：`[vars]` 中的值是**明文存储**的，任何能访问 Worker 配置的人都能看到。**绝对不要在这里放 API Key**。

---

## 7. 部署方式一：Wrangler CLI 本地部署（推荐）

这是最直接、最可控的部署方式。

### 7.1 登录 Cloudflare

```bash
wrangler login
```

执行后浏览器会打开 Cloudflare 授权页面。点击 **Allow** 授权 Wrangler 访问你的 Cloudflare 账户。

授权成功后，命令行会显示 `Successfully logged in.`，同时会在本地生成一个 OAuth token（存放在 `~/.wrangler/` 目录下）。

### 7.2 语法检查（可选但推荐）

```bash
npm run check
```

这会检查 `src/worker.js` 是否有语法错误。如果通过，不会有输出；如果有错误，会显示错误信息。

### 7.3 本地开发/测试（可选）

```bash
npm run dev
```

这会启动本地开发服务器（默认 `http://localhost:8787`），可以在本地测试 Worker 而不需要部署到 Cloudflare。按 `Ctrl+C` 停止。

### 7.4 部署到 Cloudflare

```bash
npm run deploy
```

或者直接运行：

```bash
wrangler deploy
```

部署成功后会显示类似：

```
Total Upload: 25.12 KiB / gzip: 8.45 KiB
Uploaded unlimited-transfer-api (2.31 sec)
Published unlimited-transfer-api (1.02 sec)
  https://unlimited-transfer-api.你的用户名.workers.dev
```

**记下输出的 URL**，这就是你的 Worker 端点。

### 7.5 配置 Secrets

部署后还需要设置密钥，详见 [第 10 节](#10-secrets-密钥配置所有部署方式通用)。

---

## 8. 部署方式二：GitHub + Cloudflare 自动部署

适合需要持续集成、团队协作的场景。推送代码到 GitHub 后，Cloudflare 会自动构建和部署。

### 8.1 推送到 GitHub

```bash
# 如果还没有克隆，先创建自己的仓库并推送
git clone https://github.com/ihbqcjump/unlimited.surf.git
cd unlimited.surf

# 修改 remote 为你自己的仓库
git remote set-url origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

### 8.2 在 Cloudflare 连接 GitHub

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单点击 **Workers & Pages**
3. 点击 **Create** 按钮
4. 选择 **Pages** 标签页（不是 Workers）
5. 选择 **Connect to Git**
6. 如果首次使用，需要授权 Cloudflare 访问 GitHub（按提示操作）
7. 选择你推送了本项目代码的 GitHub 仓库

### 8.3 配置构建参数

在 Cloudflare 的部署配置页面中填入：

| 参数 | 值 |
|------|------|
| Framework preset | `None` |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
| Root directory (path) | `/`（项目根目录） |

如果 Cloudflare 只提供了一个命令输入框（Build command），可以合并为：

```bash
npm install && npx wrangler deploy
```

### 8.4 首次部署

点击 **Save and Deploy**。Cloudflare 会自动：

1. 从 GitHub 拉取代码
2. 执行 `npm install` 安装 wrangler 依赖
3. 执行 `npx wrangler deploy` 部署 Worker
4. 输出 Worker URL

### 8.5 后续更新

之后每次向 GitHub 推送代码（`git push`），Cloudflare 会自动重新部署。

---

## 9. 部署方式三：Cloudflare Dashboard 手动上传

最简单的方式，适合快速测试，不需要安装任何工具。

### 9.1 创建 Worker

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单点击 **Workers & Pages**
3. 点击 **Create**
4. 选择 **Workers** 标签页
5. 点击 **Create Worker**
6. 输入 Worker 名称（如 `unlimited-transfer-api`）
7. 点击 **Deploy**（这会部署一个默认的 Hello World Worker）

### 9.2 上传代码

1. 部署后进入 Worker 页面
2. 点击 **Edit code**（编辑代码）
3. 在左侧文件树中，找到 `src/worker.js`（如果没有 `src` 目录，需要先创建）
4. 将本项目 `src/worker.js` 的全部内容粘贴进去，替换默认代码
5. 点击右上角 **Deploy**

**注意**：Dashboard 上传方式**不支持 `wrangler.toml` 的 `[vars]` 配置**。默认值会使用代码中的常量（`DEFAULT_UPSTREAM_BASE_URL = "https://unlimited.surf"` 等）。如果需要自定义环境变量，请使用方式一或方式二。

### 9.3 配置 Secrets

在 Worker 页面中：

1. 点击 **Settings** 标签页
2. 点击左侧 **Variables**
3. 在 **Secrets** 区域点击 **Add binding**
4. 按照 [第 10 节](#10-secrets-密钥配置所有部署方式通用) 的说明添加密钥

---

## 10. Secrets 密钥配置（所有部署方式通用）

**这一步在所有部署方式中都是必须的。** 密钥通过 Cloudflare Secrets 存储，会被加密保存，不会出现在代码或配置文件中。

### 10.1 需要配置的 Secrets

| Secret 名称 | 是否必需 | 说明 |
|-------------|---------|------|
| `UNLIMITED_SURF_API_KEY` | **必需** | unlimited.surf 的 API 密钥（格式如 `ua_xxxxxxxx`），Worker 用它请求上游 |
| `WORKER_API_KEY` | 可选 | 你自定义的客户端访问密钥，用来保护 Worker 不被他人滥用 |

### 10.2 通过 Wrangler CLI 设置（推荐）

```bash
# 设置上游 API Key（必需）
wrangler secret put UNLIMITED_SURF_API_KEY
# 系统会提示你输入密钥值，输入后按回车

# 设置客户端访问密钥（可选但推荐）
wrangler secret put WORKER_API_KEY
# 输入你想设定的客户端密钥
```

**输入密钥时不会在屏幕上显示字符**（安全设计），直接输入后按回车即可。

### 10.3 通过 Cloudflare Dashboard 设置

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages** → 你的 Worker
3. 点击 **Settings** → **Variables**
4. 在 **Secrets** 区域，点击 **Add binding**
5. Variable name 填 `UNLIMITED_SURF_API_KEY`
6. Secret value 填你的 unlimited.surf API Key
7. 点击 **Deploy** 保存
8. 如需设置客户端密钥，重复步骤 4-7，Variable name 填 `WORKER_API_KEY`

### 10.4 验证 Secrets 是否生效

```bash
# 查看当前已设置的 Secrets 列表（只显示名称，不显示值）
wrangler secret list
```

输出示例：

```json
[
  { "name": "UNLIMITED_SURF_API_KEY", "type": "secret_text" },
  { "name": "WORKER_API_KEY", "type": "secret_text" }
]
```

### 10.5 更新或删除 Secrets

```bash
# 更新（重新输入新值即可覆盖）
wrangler secret put UNLIMITED_SURF_API_KEY

# 删除
wrangler secret delete WORKER_API_KEY
```

---

## 11. 自定义域名绑定

如果你不想使用默认的 `*.workers.dev` 域名，可以绑定自己的域名。

### 11.1 前提条件

- 你的域名必须托管在 Cloudflare（在 Cloudflare Dashboard 中已经添加了该域名的 Zone）

### 11.2 配置 wrangler.toml

编辑 `wrangler.toml`，取消 `routes` 的注释并填入你的域名：

```toml
routes = [
  { pattern = "api.yourdomain.com", zone_name = "yourdomain.com", custom_domain = true }
]
```

### 11.3 部署

```bash
wrangler deploy
```

部署成功后，Cloudflare 会自动：

1. 在 DNS 中添加一条 CNAME 记录指向你的 Worker
2. 为该子域名签发 SSL 证书
3. Worker 可以通过 `https://api.yourdomain.com` 访问

### 11.4 验证域名绑定

```bash
curl https://api.yourdomain.com/health
```

看到 `"ok": true` 即表示域名绑定成功。

### 11.5 不使用 wrangler.toml 的替代方法

也可以通过 Dashboard 手动绑定：

1. 进入 Worker 页面 → **Triggers** 标签页
2. 点击 **Add Custom Domain**
3. 输入子域名和选择 Zone
4. 点击 **Add Custom Domain**

---

## 12. 部署后验证

### 12.1 健康检查

```bash
# 如果设置了 WORKER_API_KEY，需要带上 Authorization 头
curl https://你的worker地址/health \
  -H "Authorization: Bearer 你的WORKER_API_KEY"
```

期望响应：

```json
{
  "ok": true,
  "service": "unlimited.surf OpenAI/Anthropic compatibility Worker",
  "upstream": "https://unlimited.surf",
  "routes": {
    "raw": "...",
    "openai": "...",
    "anthropic": "...",
    "setup": "..."
  }
}
```

### 12.2 测试模型列表

```bash
# OpenAI 格式
curl https://你的worker地址/v1/models \
  -H "Authorization: Bearer 你的WORKER_API_KEY"

# Anthropic 格式
curl https://你的worker地址/v1/models \
  -H "Authorization: Bearer 你的WORKER_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```

### 12.3 测试 OpenAI 对话

```bash
curl https://你的worker地址/v1/chat/completions \
  -H "Authorization: Bearer 你的WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gateway-gpt-5",
    "messages": [{"role": "user", "content": "Hello, are you working?"}]
  }'
```

### 12.4 测试 Anthropic 对话

```bash
curl https://你的worker地址/v1/messages \
  -H "Authorization: Bearer 你的WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello from Anthropic API!"}]
  }'
```

### 12.5 测试 Tool Calling（本项目核心功能）

```bash
curl https://你的worker地址/v1/messages \
  -H "Authorization: Bearer 你的WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "input_schema": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名称" }
          },
          "required": ["city"]
        }
      }
    ],
    "messages": [
      { "role": "user", "content": "北京今天天气怎么样？" }
    ]
  }'
```

**期望响应**（关键是 `content` 数组中包含 `tool_use` 类型的内容块）：

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "我来帮你查询北京的天气。" },
    {
      "type": "tool_use",
      "id": "toolu_...",
      "name": "get_weather",
      "input": { "city": "北京" }
    }
  ],
  "stop_reason": "tool_use"
}
```

如果看到 `stop_reason: "tool_use"` 和 `type: "tool_use"` 的内容块，说明 Tool Calling 功能正常工作。

**对比**：如果使用原版 `eooce/transfer-api` 发送相同的请求，响应中不会有 `tool_use` 块，只会返回纯文本（因为 tools 被序列化为文字描述了）。

---

## 13. Tool Calling 使用指南（核心增强功能）

### 13.1 什么是 Tool Calling

Tool Calling（工具调用）是 Anthropic Messages API 的核心功能，允许模型在对话中调用外部工具。模型会返回 `tool_use` 类型的内容块，包含工具名称和输入参数，客户端执行工具后将结果以 `tool_result` 形式返回，模型再继续生成回复。

### 13.2 为什么需要本项目的修复

原版 Worker 的处理流程：

```
客户端请求（含 tools 数组）
  → Worker 将 tools 序列化为纯文本描述
  → 通过 /api/chat 发送纯文本到上游
  → 上游返回纯文本回复（不知道有工具可用）
  → 客户端收到的回复中没有 tool_use 块
```

本项目的处理流程：

```
客户端请求（含 tools 数组）
  → Worker 检测到 body.tools 非空
  → 将完整请求体代理到 /v1/messages
  → 上游返回包含 tool_use 块的完整 Anthropic 响应
  → 客户端可以正常执行工具调用循环
```

### 13.3 自动路由逻辑

Worker 使用以下逻辑自动选择路径，**客户端无需做任何特殊处理**：

```javascript
// src/worker.js 中的 anthropicMessages() 函数
if (Array.isArray(body.tools) && body.tools.length > 0) {
  // 有 tools → 走直连代理（保留完整 tool calling）
  return proxyAnthropicMessages(request, env, body);
}
// 无 tools → 走原版文本转换路径
```

### 13.4 流式模式下的 Tool Calling

设置 `"stream": true` 时，Worker 会透传上游的完整 SSE 事件流。与 tool calling 相关的 SSE 事件：

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"让我帮你"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"北京\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},...}

event: message_stop
data: {"type":"message_stop"}
```

关键事件是 `input_json_delta`，它逐步传递工具调用的输入参数。

### 13.5 完整的 Tool Calling 循环示例

```javascript
// 第一次请求：发送带 tools 的消息
const response1 = await fetch("https://你的worker/v1/messages", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_KEY",
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    tools: [{
      name: "calculator",
      description: "执行数学计算",
      input_schema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式" }
        },
        required: ["expression"]
      }
    }],
    messages: [{ role: "user", content: "计算 123 * 456 + 789" }]
  })
});

// response1 会包含 tool_use 块
// content: [
//   { type: "text", text: "让我计算一下..." },
//   { type: "tool_use", id: "toolu_xxx", name: "calculator", input: { expression: "123 * 456 + 789" } }
// ]
// stop_reason: "tool_use"

// 在客户端执行工具（这里是简单的 eval，实际场景调用真实 API）
const toolResult = eval("123 * 456 + 789");  // 56877

// 第二次请求：返回 tool_result
const response2 = await fetch("https://你的worker/v1/messages", {
  method: "POST",
  headers: { /* 同上 */ },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    tools: [/* 同上 */],
    messages: [
      { role: "user", content: "计算 123 * 456 + 789" },
      { role: "assistant", content: response1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_xxx", content: String(toolResult) }] }
    ]
  })
});

// response2 会包含最终回复
// content: [{ type: "text", text: "123 × 456 + 789 = 56,877" }]
// stop_reason: "end_turn"
```

---

## 14. 客户端接入示例

### 14.1 OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://你的worker/v1",
    api_key="你的WORKER_API_KEY"  # 或 unlimited.surf key（如果未设置 WORKER_API_KEY）
)

response = client.chat.completions.create(
    model="gateway-gpt-5",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the capital of France?"}
    ]
)
print(response.choices[0].message.content)
```

### 14.2 Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://你的worker",
    api_key="你的WORKER_API_KEY"
)

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Hello, Claude!"}
    ]
)
print(response.content[0].text)
```

### 14.3 Anthropic SDK + Tool Calling

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://你的worker",
    api_key="你的WORKER_API_KEY"
)

tools = [
    {
        "name": "get_weather",
        "description": "获取天气信息",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string"}
            },
            "required": ["city"]
        }
    }
]

# 第一次请求
response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "上海天气如何？"}]
)

# 检查是否需要工具调用
if response.stop_reason == "tool_use":
    tool_use_block = next(block for block in response.content if block.type == "tool_use")
    print(f"模型想调用: {tool_use_block.name}({tool_use_block.input})")

    # 执行工具并返回结果
    tool_result = {"temperature": 28, "condition": "晴"}

    # 第二次请求
    response2 = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        tools=tools,
        messages=[
            {"role": "user", "content": "上海天气如何？"},
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tool_use_block.id, "content": str(tool_result)}
            ]}
        ]
    )
    print(response2.content[0].text)
```

### 14.4 Claude Code (PowerShell)

```powershell
$env:ANTHROPIC_BASE_URL = "https://你的worker"
$env:ANTHROPIC_AUTH_TOKEN = "你的WORKER_API_KEY"
$env:ANTHROPIC_API_KEY = "你的WORKER_API_KEY"
$env:ANTHROPIC_MODEL = "claude-opus-4-7-20260101"
claude
```

### 14.5 Claude Code (Bash)

```bash
export ANTHROPIC_BASE_URL="https://你的worker"
export ANTHROPIC_AUTH_TOKEN="你的WORKER_API_KEY"
export ANTHROPIC_API_KEY="你的WORKER_API_KEY"
export ANTHROPIC_MODEL="claude-opus-4-7-20260101"
claude
```

### 14.6 Hermes / 其他 AI Agent

在 Agent 的 provider 配置中：

```yaml
provider:
  name: "5glion"  # 或任意名称
  api_mode: "anthropic_messages"
  base_url: "https://你的worker/v1"
  api_key: "你的WORKER_API_KEY"
  model: "claude-sonnet-4-20250514"
```

### 14.7 curl 快速测试

```bash
# 健康检查
curl https://你的worker/health -H "Authorization: Bearer YOUR_KEY"

# OpenAI 格式对话
curl https://你的worker/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hi"}]}'

# Anthropic 格式对话
curl https://你的worker/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":256,"messages":[{"role":"user","content":"Hi"}]}'

# Anthropic Tool Calling
curl https://你的worker/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"tools":[{"name":"ping","description":"Ping a host","input_schema":{"type":"object","properties":{"host":{"type":"string"}},"required":["host"]}}],"messages":[{"role":"user","content":"ping google.com"}]}'

# 流式对话
curl https://你的worker/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Count from 1 to 10"}]}'
```

---

## 15. API 端点完整列表

### 15.1 基础端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` 或 `/health` | 健康检查，返回 Worker 信息和可用路由 |
| GET | `/v1/setup` | 返回 Agent 配置说明（Claude Code、Hermes 等） |
| GET | `/v1/codex` | 返回 Codex 配置说明 |
| GET | `/v1/mcp` | 返回 MCP 集成说明 |

### 15.2 OpenAI 兼容端点

| 方法 | 路径 | 对应上游 | 说明 |
|------|------|---------|------|
| GET | `/v1/models` | `GET /api/models` | 列出可用模型（OpenAI 格式） |
| POST | `/v1/chat/completions` | `POST /api/chat` | 对话补全（支持流式） |
| POST | `/v1/responses` | `POST /api/chat` | Responses API（支持流式） |
| POST | `/v1/search` | `POST /api/search` | 联网搜索 |
| POST | `/v1/merge` | `POST /api/merge` | 多模型合并 |
| GET | `/v1/key` | `GET /api/key` | 查询 API Key 信息 |
| GET | `/v1/usage` | `GET /api/usage` | 查询用量 |
| POST | `/v1/files` | `POST /api/attachments/extract` | 文件上传（提取内容） |
| POST | `/v1/files/extract` | `POST /api/attachments/extract` | 文件内容提取 |
| POST | `/v1/attachments/extract` | `POST /api/attachments/extract` | 附件内容提取 |
| GET | `/v1/files/:id` | - | 返回 404（Worker 无状态，需接 KV/R2） |
| POST | `/v1/embeddings` | - | 返回 501（不支持） |
| POST | `/v1/audio/*` | - | 返回 501（不支持） |
| POST | `/v1/images/*` | - | 返回 501（不支持） |

### 15.3 Anthropic 兼容端点

| 方法 | 路径 | 对应上游 | 说明 |
|------|------|---------|------|
| POST | `/v1/messages` | `/api/chat`（无 tools）或 `/v1/messages`（有 tools） | 消息发送（**核心增强**） |
| GET | `/v1/models` | `GET /api/models` | 列出可用模型（Anthropic 格式，自动检测） |
| POST | `/v1/search` | `POST /api/search` | 联网搜索 |
| POST | `/v1/merge` | `POST /api/merge` | 多模型合并 |
| GET | `/v1/key` | `GET /api/key` | Key 信息 |
| GET | `/v1/usage` | `GET /api/usage` | 用量查询 |
| GET | `/v1/setup` | - | Agent 配置说明 |
| POST | `/anthropic/v1/messages` | 同上 | `/anthropic` 前缀的别名 |
| GET | `/anthropic/v1/models` | 同上 | `/anthropic` 前缀的别名 |
| POST | `/anthropic/messages` | 同上 | 无版本号的别名 |

### 15.4 原始 API 透传

| 方法 | 路径 | 说明 |
|------|------|------|
| ANY | `/api/*` | 直接转发到 unlimited.surf，自动带上 API Key |

---

## 16. 密钥优先级规则详解

Worker 支持灵活的密钥配置，以下是完整的优先级逻辑：

### 场景一：设置了 WORKER_API_KEY + UNLIMITED_SURF_API_KEY（推荐）

```
客户端请求 → Authorization: Bearer <WORKER_API_KEY>
Worker 验证 → 匹配 WORKER_API_KEY，通过
Worker 请求上游 → Authorization: Bearer <UNLIMITED_SURF_API_KEY>
```

- 客户端**必须**传 `WORKER_API_KEY`
- Worker 用 `UNLIMITED_SURF_API_KEY` 请求上游
- unlimited.surf 的真实 Key 对客户端完全不可见

### 场景二：只设置了 UNLIMITED_SURF_API_KEY

```
客户端请求 → Authorization: Bearer <任意值>
Worker 验证 → 没有 WORKER_API_KEY，跳过验证
Worker 请求上游 → Authorization: Bearer <UNLIMITED_SURF_API_KEY>
```

- 客户端可以传**任意 Key**（或空）
- Worker 始终用 `UNLIMITED_SURF_API_KEY` 请求上游
- 适合个人使用、不担心被滥用的场景

### 场景三：只设置了 WORKER_API_KEY

```
客户端请求 → Authorization: Bearer <WORKER_API_KEY>
Worker 验证 → 匹配 WORKER_API_KEY，通过
Worker 请求上游 → 报错（缺少 UNLIMITED_SURF_API_KEY）
```

- **不推荐**。设置了 `WORKER_API_KEY` 就必须同时设置 `UNLIMITED_SURF_API_KEY`。

### 场景四：两者都未设置

```
客户端请求 → Authorization: Bearer <unlimited.surf 真实 Key>
Worker 验证 → 没有 WORKER_API_KEY，跳过验证
Worker 请求上游 → Authorization: Bearer <客户端传入的 Key>
```

- 客户端**直接传 unlimited.surf 的真实 Key**
- 安全性最低（真实 Key 暴露给客户端）
- 仅用于快速测试

### 支持的请求头格式

Worker 接受以下任意一种格式传递 API Key：

```
Authorization: Bearer sk-xxxxx
Authorization: Bearer ua_xxxxx
x-api-key: sk-xxxxx
anthropic-api-key: sk-xxxxx
```

---

## 17. 更新 Worker

### 17.1 通过 Wrangler CLI

```bash
# 拉取最新代码
cd unlimited.surf
git pull origin main

# 重新部署
wrangler deploy
```

Secrets 在重新部署后**不会丢失**，它们独立于代码存储。

### 17.2 通过 GitHub 自动部署

推送代码到 GitHub 仓库，Cloudflare 会自动重新部署。

### 17.3 通过 Dashboard

1. 进入 Worker → Edit code
2. 更新 `src/worker.js` 的内容
3. 点击 Deploy

### 17.4 回滚

如果新版本有问题，可以通过 Wrangler 回滚到上一个版本：

```bash
# 查看部署历史
wrangler versions list

# 回滚到指定版本
wrangler rollback <version-id>
```

---

## 18. 常见问题排查

### Q1: 部署后访问 /health 返回 401 Unauthorized

**原因**：设置了 `WORKER_API_KEY` 但没有在请求中传递。

**解决**：

```bash
curl https://你的worker/health \
  -H "Authorization: Bearer 你的WORKER_API_KEY"
```

### Q2: 请求返回 `upstream_error` 或 500 错误

**原因**：上游 unlimited.surf 返回错误。可能是：
- `UNLIMITED_SURF_API_KEY` 未设置或无效
- unlimited.surf 服务暂时不可用
- 请求的模型不存在

**排查步骤**：

1. 验证 Secrets：`wrangler secret list`
2. 测试上游连通性：`curl https://unlimited.surf/api/key -H "Authorization: Bearer 你的key"`
3. 检查模型名称是否正确

### Q3: Tool Calling 不工作（响应中没有 tool_use）

**可能原因和排查**：

1. **确认使用的是本项目而非原版**：检查 Worker 代码中是否有 `proxyAnthropicMessages` 函数
2. **确认请求格式正确**：
   - 必须是 `POST /v1/messages`（不是 `/v1/chat/completions`）
   - 请求体必须包含 `"tools": [...]` 数组
   - tools 数组必须非空
3. **确认模型支持 tool calling**：使用 `claude-sonnet-4-20250514` 或 `claude-opus-4-7-20260101`
4. **检查请求头**：必须包含 `anthropic-version: 2023-06-01`

### Q4: 流式请求中断或卡住

**原因**：SSE 连接被中间代理切断。

**解决**：
- 如果使用了 Nginx 等反向代理，需要关闭 buffer：`proxy_buffering off;`
- 检查防火墙或安全软件是否拦截了长连接
- 使用 `X-Accel-Buffering: no` 响应头（Worker 已自动设置）

### Q5: CORS 错误（浏览器中调用 Worker）

**说明**：Worker 已配置 CORS 允许所有来源（`Access-Control-Allow-Origin: *`）。如果仍然报错：

1. 检查是否先发了 OPTIONS 预检请求（Worker 会自动返回 204）
2. 确认请求头在 `Access-Control-Allow-Headers` 范围内
3. 浏览器开发者工具 → Network 标签 → 查看具体哪个请求触发了 CORS 错误

### Q6: 部署时提示 `No account selected`

```bash
# 查看当前登录的账户
wrangler whoami

# 重新登录
wrangler login

# 如果有多个账户，指定 account_id
wrangler deploy --account-id 你的账户ID
```

### Q7: 免费额度不够用

Cloudflare Workers 免费计划每天 10 万次请求。如果超过：

- 升级到 Workers Paid 计划（$5/月，包含 1000 万次请求）
- 在 `wrangler.toml` 中设置 `usage_model = "bundled"` 使用 bundled 定价

### Q8: 如何查看 Worker 日志

```bash
# 实时查看日志（Wrangler CLI）
wrangler tail

# 或从 Dashboard：
# Workers & Pages → 你的 Worker → Logs → Begin log stream
```

---

## 19. 安全最佳实践

### 19.1 密钥管理

- **永远不要**将 API Key 提交到 Git 仓库
- **永远不要**在 `wrangler.toml` 的 `[vars]` 中存放密钥
- 使用 Cloudflare Secrets 存储所有敏感信息
- 定期轮换 `WORKER_API_KEY`

### 19.2 访问控制

- **强烈建议**设置 `WORKER_API_KEY`，避免 Worker 被公开滥用
- 如果需要更细粒度的控制，可以在 Worker 前面加一层 Cloudflare Access
- 考虑使用 Cloudflare WAF 规则限制访问来源

### 19.3 监控

- 在 Cloudflare Dashboard 设置告警（用量异常、错误率高等）
- 定期查看 Worker 日志（`wrangler tail` 或 Dashboard Logs）
- 监控 unlimited.surf 的用量（`GET /v1/usage`）

### 19.4 代码安全

- 不要修改 `src/worker.js` 中的 CORS 头（除非你知道在做什么）
- 不要删除 `validateWorkerApiKey()` 函数
- 更新代码时仔细 review diff

---

## 20. 与原版逐项对比表

| 项目 | eooce/transfer-api | 本项目 (ihbqcjump/unlimited.surf) |
|------|--------------------|------------------------------------|
| OpenAI 兼容 | 支持 | 支持（完全一致） |
| Anthropic 基础对话 | 支持（文本转换） | 支持（无 tools 时文本转换，完全一致） |
| **Anthropic Tool Calling** | **不支持** | **完整支持** |
| 流式响应（无 tools） | 支持 | 支持（完全一致） |
| **流式响应（有 tools）** | **不支持** | **支持（SSE 透传）** |
| `/v1/responses` | 支持 | 支持（完全一致） |
| Web Search | 支持 | 支持（完全一致） |
| Merge AI | 支持 | 支持（完全一致） |
| 文件上传/提取 | 支持 | 支持（完全一致） |
| 原始 API 透传 | 支持 | 支持（完全一致） |
| wrangler.toml | 基础配置 | 增强配置（vars、routes 模板） |
| 部署文档 | 简略 | 完整部署指南（本文档） |
| 代码注释 | 英文 | 中英双语 |
| 自定义域名 | 需手动配置 | routes 模板 + 文档说明 |
| 密钥配置说明 | 无 | 完整的优先级规则 |
| 上游端点（有 tools） | `/api/chat` | **`/v1/messages`**（直连代理） |
| `anthropic-version` 透传 | 否 | **是**（直连路径） |
| `anthropic-beta` 透传 | 否 | **是**（直连路径） |
| 新增函数 | - | `proxyAnthropicMessages()`, `proxyAnthropicStream()` |
| 修改函数 | - | `anthropicMessages()`（增加 tools 检测） |

---

<a id="english-section"></a>

---

# Complete Cloudflare Deployment Guide

This document is the full deployment reference for this project. Whether you're new to Cloudflare Workers or want to understand exactly how this differs from the original `eooce/transfer-api`, you'll find everything here.

## What This Project Is

A Cloudflare Worker adapter that converts `unlimited.surf`'s internal API into standard OpenAI-compatible and Anthropic-compatible endpoints. After deployment, you get a publicly accessible API endpoint that works with any client supporting OpenAI or Anthropic API formats (SDKs, IDE plugins, AI agents, etc.).

## Key Difference from the Original

The original `eooce/transfer-api` **does not support Anthropic tool calling**. When a request includes `tools`, the original Worker serializes them as plain text and sends via `/api/chat` — the model can't produce `tool_use` responses.

This project fixes that: when `tools` are detected, the Worker proxies the full Anthropic Messages request directly to upstream's `/v1/messages` endpoint, which natively supports tool calling including `tool_use` content blocks, `input_json_delta` streaming events, and header pass-through.

**Requests without tools behave identically to the original** — no breaking changes.

## Quick Start (5 Minutes)

```bash
# 1. Clone and install
git clone https://github.com/ihbqcjump/unlimited.surf.git
cd unlimited.surf
npm install

# 2. Login to Cloudflare
wrangler login

# 3. Deploy
wrangler deploy

# 4. Set your API keys
wrangler secret put UNLIMITED_SURF_API_KEY
# Enter your unlimited.surf key (format: ua_xxxxxxxx)

wrangler secret put WORKER_API_KEY
# Enter a custom key for client access (optional but recommended)

# 5. Verify
curl https://your-worker.workers.dev/health \
  -H "Authorization: Bearer YOUR_WORKER_API_KEY"
```

## Deployment Methods

### Method 1: Wrangler CLI (Recommended)

Most direct approach. Install wrangler (`npm install -g wrangler`), login, deploy:

```bash
wrangler login
wrangler deploy
wrangler secret put UNLIMITED_SURF_API_KEY
wrangler secret put WORKER_API_KEY
```

### Method 2: GitHub Auto-Deploy

1. Push code to your GitHub repo
2. In Cloudflare Dashboard → Workers & Pages → Create → Connect to Git
3. Set build command to `npm install && npx wrangler deploy`
4. Configure secrets via Dashboard → Settings → Variables

### Method 3: Dashboard Manual Upload

1. Create a Worker in Dashboard
2. Click "Edit code"
3. Paste the contents of `src/worker.js`
4. Deploy and configure secrets in Settings → Variables

## Secrets Configuration

| Secret | Required | Purpose |
|--------|----------|---------|
| `UNLIMITED_SURF_API_KEY` | Yes | Your unlimited.surf API key for upstream requests |
| `WORKER_API_KEY` | No | Custom client-facing key to protect your Worker |

Priority rules:

- **Both set**: clients send `WORKER_API_KEY`, Worker uses `UNLIMITED_SURF_API_KEY` upstream
- **Only UNLIMITED_SURF_API_KEY**: clients send any key, Worker uses `UNLIMITED_SURF_API_KEY` upstream
- **Neither set**: clients send the real unlimited.surf key directly (not recommended)

## Custom Domain

Edit `wrangler.toml`, uncomment `routes`, fill in your domain:

```toml
routes = [
  { pattern = "api.yourdomain.com", zone_name = "yourdomain.com", custom_domain = true }
]
```

Then `wrangler deploy`. Requires your domain to be managed by Cloudflare.

## Verification

```bash
# Health check
curl https://your-worker/health -H "Authorization: Bearer YOUR_KEY"

# OpenAI chat
curl https://your-worker/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hello"}]}'

# Anthropic messages
curl https://your-worker/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'

# Tool calling (core feature)
curl https://your-worker/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"tools":[{"name":"ping","description":"Ping a host","input_schema":{"type":"object","properties":{"host":{"type":"string"}},"required":["host"]}}],"messages":[{"role":"user","content":"ping google.com"}]}'
```

## Client Integration

**OpenAI SDK (Python)**:

```python
from openai import OpenAI
client = OpenAI(base_url="https://your-worker/v1", api_key="YOUR_KEY")
response = client.chat.completions.create(model="gateway-gpt-5", messages=[{"role":"user","content":"Hi"}])
```

**Anthropic SDK (Python)**:

```python
from anthropic import Anthropic
client = Anthropic(base_url="https://your-worker", api_key="YOUR_KEY")
response = client.messages.create(model="claude-sonnet-4-20250514", max_tokens=256, messages=[{"role":"user","content":"Hi"}])
```

**Claude Code (Bash)**:

```bash
export ANTHROPIC_BASE_URL="https://your-worker"
export ANTHROPIC_API_KEY="YOUR_KEY"
export ANTHROPIC_MODEL="claude-opus-4-7-20260101"
claude
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| 401 on /health | `WORKER_API_KEY` set but not sent in request | Add `-H "Authorization: Bearer YOUR_KEY"` |
| upstream_error 500 | Missing or invalid `UNLIMITED_SURF_API_KEY` | Check `wrangler secret list`, re-set the key |
| No tool_use in response | Using original project or wrong endpoint | Use this project's Worker, POST to `/v1/messages` with `tools` array |
| Stream disconnects | Proxy/firewall cutting long connections | Check intermediary proxies, disable buffering |
| CORS error | Browser preflight blocked | Worker allows all origins; check specific request headers |

## Updating

```bash
git pull origin main
wrangler deploy
# Secrets are preserved across deployments
```

## Architecture

```
Client → Cloudflare Worker → unlimited.surf
                               ├── /api/chat (text conversion, no tools)
                               ├── /api/search (web search)
                               ├── /api/merge (multi-model)
                               └── /v1/messages (full Anthropic API, with tool_use)
```

When `tools` are present in the request body, the Worker automatically routes to `/v1/messages` instead of `/api/chat`, preserving the complete Anthropic protocol.
