# Transfer unlimited.surf API Worker

中文 | [English](#english)

这是一个 Cloudflare Worker 中转适配器，用于把 `https://unlimited.surf` 转换成 OpenAI 兼容的 `/v1/*` 接口，以及 Anthropic/Claude Code 兼容的 `/v1/messages` 和 `/anthropic/*` 接口。

> **完整部署指南请查看 [DEPLOY.md](./DEPLOY.md)** — 包含详细的部署步骤、配置说明、Troubleshooting、与原版对比等。

## Tool Calling 支持说明

本项目基于 [eooce/transfer-api](https://github.com/eooce/transfer-api) 改造，在原版基础上修复了 Anthropic Messages API 的 Tool Calling 支持问题。本项目是独立维护的增强版本，不需要也不建议与原版项目同步。

### 核心修复：Anthropic Messages API Tool Calling

**问题**：原版 `anthropicMessages()` 函数会将 Anthropic 请求中的 `tools` 定义转换为纯文本描述，然后通过 unlimited.surf 的 `/api/chat` 端点发送。这意味着 tool calling 功能被完全丢失——模型只能看到工具的文字说明，无法产生 `tool_use` 响应。

**解决方案**：当检测到请求体中包含 `tools` 数组时，Worker 不再做文本转换，而是直接将整个 Anthropic Messages API 请求代理到 unlimited.surf 的 `/v1/messages` 端点。这个端点原生支持完整的 Anthropic 协议，包括：

- `tool_use` / `tool_result` 内容块
- 流式响应中的 `content_block_start` / `content_block_delta`（含 `input_json_delta`）/ `content_block_stop` 事件
- `anthropic-version` 和 `anthropic-beta` 请求头透传

**代码变更**（位于 `src/worker.js`）：

| 函数 | 变更类型 | 说明 |
|------|----------|------|
| `anthropicMessages()` | 修改 | 新增 `body.tools` 检测逻辑：有 tools 时调用 `proxyAnthropicMessages()`，无 tools 时走原有文本转换路径 |
| `proxyAnthropicMessages()` | 新增 | 将完整的 Anthropic Messages 请求体（含 tools、messages）直接代理到上游 `/v1/messages` |
| `proxyAnthropicStream()` | 新增 | 流式代理，直接透传上游返回的 SSE 事件流，保持 tool_use 相关事件完整性 |

**无 tools 的请求**仍然走原版的文本转换路径（通过 `/api/chat`），行为与上游完全一致。

### wrangler.toml 配置增强

原版 `wrangler.toml` 只有基础配置（name、main、compatibility_date）。本仓库增加了：

```toml
# 自定义域名路由（需要先在 Cloudflare 添加域名）
routes = [
  { pattern = "your-domain.com", zone_name = "your-zone", custom_domain = true }
]

# 环境变量（建议将密钥放在 Cloudflare Secrets 而非此处）
[vars]
UPSTREAM_BASE_URL = "https://unlimited.surf"
DEFAULT_MODEL = "gateway-gpt-5-5"
DEFAULT_CLAUDE_MODEL = "claude-opus-4-7-20260101"
WORKER_API_KEY = "<通过 Secrets 设置>"
UNLIMITED_SURF_API_KEY = "<通过 Secrets 设置>"
```

**注意**：`wrangler.toml` 中的 `WORKER_API_KEY` 和 `UNLIMITED_SURF_API_KEY` 只是占位说明。实际部署时请通过 Cloudflare Secrets 设置，不要将真实密钥提交到代码仓库。

### 部署方式区别

本仓库支持两种部署方式：

- **GitHub + Cloudflare 自动部署**：与原项目一致，推送代码后 Cloudflare 自动构建部署。
- **Wrangler CLI 手动部署**：适合需要精确控制部署配置的场景（如自定义域名、环境变量等），详见下方部署章节。

如果使用自定义域名，需要额外步骤：
1. 在 Cloudflare Dashboard 添加域名并配置 DNS
2. 在 `wrangler.toml` 的 `routes` 中配置域名
3. 部署时 Worker 会自动绑定到指定域名

## 功能概览

- OpenAI 兼容：`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/files`。
- Anthropic 兼容：`/v1/messages`、`/v1/models`、`/anthropic/v1/messages`、`/anthropic/v1/models`。
- unlimited.surf 原始接口代理：`/api/*` 会直接转发到上游。
- Web Search：映射到上游 `POST /api/search`。
- Merge AI：映射到上游 `POST /api/merge`。
- Files：上传/提取映射到上游 `POST /api/attachments/extract`。
- Agent Setup、Codex、MCP：提供说明和配置入口，分别是 `/v1/setup`、`/v1/codex`、`/v1/mcp`。

注意：MCP server 仍然需要在本地 agent、IDE 或 Claude Code/Codex 环境里运行。这个 Worker 只提供模型 API 端点，不会在 Cloudflare 边缘侧读取或修改你的本地文件。

## 通过 GitHub 关联 Cloudflare 自动部署

可以把本项目推送到 GitHub 私有仓库，然后让 Cloudflare 在每次提交后自动部署。

### 1. 推送到 GitHub

创建 GitHub 仓库并推送本项目。不要把 unlimited.surf API key 提交进仓库。

### 2. 在 Cloudflare 连接 GitHub 仓库

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 点击 `Create`。
4. 选择 `Import a repository` 或 `Connect to Git`。
5. 按提示授权 Cloudflare 访问 GitHub。
6. 选择这个项目所在的 GitHub 仓库。
7. Root directory 填 `/`，除非你把项目放在仓库子目录里。

### 3. 配置构建和部署参数

Cloudflare 部署表单里可以使用：

```text
Framework preset: None
Build command: npm install
Deploy command: npx wrangler deploy
Root directory: /
Wrangler config: wrangler.toml
```

如果 Cloudflare 只提供一个命令输入框，可以填：

```bash
npm install && npx wrangler deploy
```

### 4. 添加 Cloudflare Secret

在 Worker 设置里添加上游 key：

```text
UNLIMITED_SURF_API_KEY=<你的 unlimited.surf key>
```

推荐再添加一个客户端访问 key，用来保护你的 Worker：

```text
WORKER_API_KEY=<你自定义的调用密钥>
```

通常位置是：

```text
Workers & Pages -> 你的 Worker -> Settings -> Variables -> Secrets
```

请只把 key 放到 Secret 里，不要写进 `wrangler.toml`、`README.md` 或任何 GitHub 文件。

如果设置了 `WORKER_API_KEY`，客户端调用 Worker 时必须传这个 key。如果没有设置 `WORKER_API_KEY`，Worker 会保持兼容模式，客户端传任意 key 都可以，真正请求上游时使用 `UNLIMITED_SURF_API_KEY`。

### 5. 部署后验证

部署完成后打开：

```text
https://<your-worker>.workers.dev/health
```

看到 JSON 里有 `"ok": true` 即表示 Worker 正常运行。

如果已经设置 `WORKER_API_KEY`，验证请求也需要带上它：

```bash
curl https://<your-worker>.workers.dev/health \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>"
```

测试 OpenAI 模型列表：

```bash
curl https://<your-worker>.workers.dev/v1/models \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>"
```

测试 Anthropic/Agent 配置说明：

```bash
curl https://<your-worker>.workers.dev/v1/setup \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>"
```

## 本地 Wrangler 手动部署

也可以在本地直接部署：

```powershell
npm install -g wrangler
wrangler login
wrangler secret put UNLIMITED_SURF_API_KEY
wrangler secret put WORKER_API_KEY
wrangler deploy
```

`UNLIMITED_SURF_API_KEY` 填 unlimited.surf 的真实 key。`WORKER_API_KEY` 填你自定义给客户端使用的 key。

`WORKER_API_KEY` 是可选的：如果不设置，客户端可以传任意 key；如果设置了，客户端必须传这个 key。也可以不配置 `UNLIMITED_SURF_API_KEY`，改为每次请求直接传 unlimited.surf key，但不推荐这样做。

## 调用时使用哪个 key

推荐配置两个 Secret：

```text
UNLIMITED_SURF_API_KEY=<你的 unlimited.surf key>
WORKER_API_KEY=<你自定义的客户端 key>
```

客户端调用时使用 `WORKER_API_KEY`，不要直接暴露 unlimited.surf key：

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hello"}]}'
```

规则如下：

```text
设置了 WORKER_API_KEY:
  客户端必须传 WORKER_API_KEY
  Worker 使用 UNLIMITED_SURF_API_KEY 请求 unlimited.surf

没有设置 WORKER_API_KEY:
  客户端传任意 key 都可以
  Worker 优先使用 UNLIMITED_SURF_API_KEY 请求 unlimited.surf
  如果也没有 UNLIMITED_SURF_API_KEY，则把客户端传入的 key 当作 unlimited.surf key
```

## OpenAI 兼容接口

Base URL：

```text
https://<your-worker>.workers.dev/v1
```

支持接口：

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/search`
- `POST /v1/merge`
- `GET /v1/key`、`GET /v1/usage`
- `POST /v1/files`
- `POST /v1/files/extract`、`POST /v1/attachments/extract`
- `GET /v1/setup`、`GET /v1/codex`、`GET /v1/mcp`

示例：

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <你的 WORKER_API_KEY 或 unlimited.surf key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Anthropic / Claude Code 兼容接口

Base URL：

```text
https://<your-worker>.workers.dev
```

支持接口：

- `POST /v1/messages`
- `GET /v1/models`
- `POST /anthropic/v1/messages`
- `GET /anthropic/v1/models`
- `GET /v1/setup`、`GET /v1/codex`、`GET /v1/mcp`

Claude Code PowerShell 示例：

```powershell
$env:ANTHROPIC_BASE_URL = "https://<your-worker>.workers.dev"
$env:ANTHROPIC_AUTH_TOKEN = "<你的 WORKER_API_KEY 或 unlimited.surf key>"
$env:ANTHROPIC_API_KEY = "<你的 WORKER_API_KEY 或 unlimited.surf key>"
$env:ANTHROPIC_MODEL = "claude-opus-4-7-20260101"
claude
```

### Tool Calling 使用示例（本仓库新增）

当请求包含 `tools` 时，Worker 会自动走直连代理路径，完整保留 Anthropic tool calling 协议：

```bash
curl https://<your-worker>.workers.dev/v1/messages \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>" \
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

响应中会包含 `tool_use` 类型的内容块：

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

流式模式（`"stream": true`）同样支持，SSE 事件流中会包含 `content_block_delta` 类型的 `input_json_delta` 事件，与原生 Anthropic API 行为完全一致。

## 功能映射

- Chat 映射到上游 `POST /api/chat`。
- Web Search 在调用 `/v1/search`、传入 `web_search_options`、传入 `query`，或包含 web search tool 时映射到 `POST /api/search`。
- Merge AI 在调用 `/v1/merge`、传入 `merge: true`，或传入 2 个以上 `models` 时映射到 `POST /api/merge`。
- Models 映射到上游 `GET /api/models`，如果上游不可用会返回内置 fallback 模型列表。
- Files 映射到上游 `POST /api/attachments/extract`。如果需要持久化文件，需要额外接入 Cloudflare KV 或 R2。
- Codex、Agent Setup、MCP 是配置说明入口；MCP 工具执行仍然发生在本地 agent/IDE 里。
- Embeddings、audio、images 会返回 `501`，因为当前提供的 unlimited.surf 文档中没有这些原生接口。

## 原始上游代理

任何 `/api/*` 请求都会被转发到 unlimited.surf，并自动带上配置好的 key，因此你仍然可以通过 Worker 使用原始接口。

---

## English

This is a Cloudflare Worker adapter for `https://unlimited.surf`. It exposes OpenAI-compatible `/v1/*` routes and Anthropic/Claude Code-compatible `/v1/messages` plus `/anthropic/*` aliases.

> **Full deployment guide: [DEPLOY.md](./DEPLOY.md)** — step-by-step instructions, configuration reference, troubleshooting, and comparison with the original project.

## Tool Calling Support

This project is an enhanced version based on [eooce/transfer-api](https://github.com/eooce/transfer-api), with a critical fix for Anthropic Messages API tool calling support. This is a standalone, independently maintained project — syncing with the original repository is neither needed nor recommended.

### Core Fix: Anthropic Messages API Tool Calling

**Problem**: The original `anthropicMessages()` function converts Anthropic `tools` definitions into plain text descriptions and sends them via unlimited.surf's `/api/chat` endpoint. This completely strips tool calling — the model sees only text and cannot produce `tool_use` responses.

**Solution**: When `tools` are detected in the request body, the Worker bypasses text conversion and proxies the full Anthropic Messages API request directly to unlimited.surf's `/v1/messages` endpoint, which natively supports the complete Anthropic protocol including:

- `tool_use` / `tool_result` content blocks
- Streaming events: `content_block_start`, `content_block_delta` (with `input_json_delta`), `content_block_stop`
- Pass-through of `anthropic-version` and `anthropic-beta` headers

**Code changes** (in `src/worker.js`):

| Function | Change | Description |
|----------|--------|-------------|
| `anthropicMessages()` | Modified | Added `body.tools` detection: routes to `proxyAnthropicMessages()` when tools are present, falls through to original text path otherwise |
| `proxyAnthropicMessages()` | New | Proxies the complete Anthropic Messages request body (with tools, messages) directly to upstream `/v1/messages` |
| `proxyAnthropicStream()` | New | Stream proxy that passes through SSE events from upstream, preserving tool_use event integrity |

Requests **without tools** still use the original text conversion path (via `/api/chat`), identical to upstream behavior.

### Enhanced wrangler.toml configuration

The original `wrangler.toml` contains only basic settings. This project adds:

```toml
# Custom domain routing (requires domain added to Cloudflare first)
routes = [
  { pattern = "your-domain.com", zone_name = "your-zone", custom_domain = true }
]

# Environment variables (prefer Cloudflare Secrets for keys)
[vars]
UPSTREAM_BASE_URL = "https://unlimited.surf"
DEFAULT_MODEL = "gateway-gpt-5-5"
DEFAULT_CLAUDE_MODEL = "claude-opus-4-7-20260101"
WORKER_API_KEY = "<set via Secrets>"
UNLIMITED_SURF_API_KEY = "<set via Secrets>"
```

**Note**: `WORKER_API_KEY` and `UNLIMITED_SURF_API_KEY` in `wrangler.toml` are placeholder descriptions only. Always set real keys via Cloudflare Secrets — never commit them to the repository.

### Deployment differences

This project supports two deployment methods:

- **GitHub + Cloudflare auto-deploy**: Same as the original — push code and Cloudflare builds automatically.
- **Wrangler CLI manual deploy**: For precise control over routes, custom domains, and environment variables.

For custom domain setup:
1. Add your domain in Cloudflare Dashboard and configure DNS
2. Set the domain in `wrangler.toml` under `routes`
3. The Worker binds to the domain on deploy

## Features

- OpenAI-compatible routes: `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/files`.
- Anthropic-compatible routes: `/v1/messages`, `/v1/models`, `/anthropic/v1/messages`, `/anthropic/v1/models`.
- Raw upstream proxy: `/api/*` forwards directly to unlimited.surf.
- Web Search maps to upstream `POST /api/search`.
- Merge AI maps to upstream `POST /api/merge`.
- Files extraction maps to upstream `POST /api/attachments/extract`.
- Agent Setup, Codex, and MCP info endpoints are available at `/v1/setup`, `/v1/codex`, and `/v1/mcp`.

MCP servers still run inside your local agent, IDE, Claude Code, or Codex environment. This Worker only provides the model API endpoint and does not read or modify local files from Cloudflare.

## Deploy from GitHub with Cloudflare

Push this project to a GitHub repository, then let Cloudflare deploy it automatically on each commit.

### 1. Push to GitHub

Create a GitHub repository and push this project. Do not commit your unlimited.surf API key.

### 2. Connect the repository in Cloudflare

1. Open the Cloudflare Dashboard.
2. Go to `Workers & Pages`.
3. Click `Create`.
4. Choose `Import a repository` or `Connect to Git`.
5. Authorize Cloudflare to access GitHub if prompted.
6. Select the repository containing this project.
7. Set Root directory to `/` unless the project is in a subdirectory.

### 3. Build and deploy settings

Use these values:

```text
Framework preset: None
Build command: npm install
Deploy command: npx wrangler deploy
Root directory: /
Wrangler config: wrangler.toml
```

If Cloudflare shows only one command field, use:

```bash
npm install && npx wrangler deploy
```

### 4. Add the Cloudflare Secret

Add the upstream key in the Worker settings:

```text
UNLIMITED_SURF_API_KEY=<your unlimited.surf key>
```

Recommended: add a client-facing key to protect the Worker:

```text
WORKER_API_KEY=<your custom client key>
```

The usual location is:

```text
Workers & Pages -> your Worker -> Settings -> Variables -> Secrets
```

Keep keys in Secrets only. Do not put them in `wrangler.toml`, `README.md`, or GitHub files.

If `WORKER_API_KEY` is set, clients must send that key when calling the Worker. If `WORKER_API_KEY` is not set, the Worker keeps compatibility mode and accepts any client key while using `UNLIMITED_SURF_API_KEY` for upstream requests.

### 5. Verify the deployment

Open:

```text
https://<your-worker>.workers.dev/health
```

You should see JSON with `"ok": true`.

If `WORKER_API_KEY` is set, include it in verification requests too:

```bash
curl https://<your-worker>.workers.dev/health \
  -H "Authorization: Bearer <your WORKER_API_KEY>"
```

Test OpenAI-compatible models:

```bash
curl https://<your-worker>.workers.dev/v1/models \
  -H "Authorization: Bearer <your WORKER_API_KEY>"
```

Test Anthropic/agent setup docs:

```bash
curl https://<your-worker>.workers.dev/v1/setup \
  -H "Authorization: Bearer <your WORKER_API_KEY>"
```

## Manual deploy with Wrangler

You can also deploy from your local machine:

```powershell
npm install -g wrangler
wrangler login
wrangler secret put UNLIMITED_SURF_API_KEY
wrangler secret put WORKER_API_KEY
wrangler deploy
```

Use your real unlimited.surf key for `UNLIMITED_SURF_API_KEY`. Use your own client-facing key for `WORKER_API_KEY`.

`WORKER_API_KEY` is optional. If it is not set, clients may send any key. If it is set, clients must send this exact key. You can also skip `UNLIMITED_SURF_API_KEY` and pass the real unlimited.surf key on every request, but that is not recommended.

## Which key should clients use?

Recommended setup:

```text
UNLIMITED_SURF_API_KEY=<your unlimited.surf key>
WORKER_API_KEY=<your custom client key>
```

Clients should use `WORKER_API_KEY`, not the upstream unlimited.surf key:

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <your WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hello"}]}'
```

Rules:

```text
WORKER_API_KEY is set:
  clients must send WORKER_API_KEY
  Worker uses UNLIMITED_SURF_API_KEY for unlimited.surf

WORKER_API_KEY is not set:
  clients may send any key
  Worker prefers UNLIMITED_SURF_API_KEY for unlimited.surf
  if UNLIMITED_SURF_API_KEY is also missing, the client key is treated as the unlimited.surf key
```

## OpenAI-compatible routes

Base URL:

```text
https://<your-worker>.workers.dev/v1
```

Supported routes:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/search`
- `POST /v1/merge`
- `GET /v1/key`, `GET /v1/usage`
- `POST /v1/files`
- `POST /v1/files/extract`, `POST /v1/attachments/extract`
- `GET /v1/setup`, `GET /v1/codex`, `GET /v1/mcp`

Example:

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <your WORKER_API_KEY or unlimited.surf key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Anthropic / Claude Code-compatible routes

Base URL:

```text
https://<your-worker>.workers.dev
```

Supported routes:

- `POST /v1/messages`
- `GET /v1/models`
- `POST /anthropic/v1/messages`
- `GET /anthropic/v1/models`
- `GET /v1/setup`, `GET /v1/codex`, `GET /v1/mcp`

Claude Code PowerShell example:

```powershell
$env:ANTHROPIC_BASE_URL = "https://<your-worker>.workers.dev"
$env:ANTHROPIC_AUTH_TOKEN = "<your WORKER_API_KEY or unlimited.surf key>"
$env:ANTHROPIC_API_KEY = "<your WORKER_API_KEY or unlimited.surf key>"
$env:ANTHROPIC_MODEL = "claude-opus-4-7-20260101"
claude
```

### Tool Calling Example

When a request includes `tools`, the Worker automatically routes it through the direct proxy path, preserving the full Anthropic tool calling protocol:

```bash
curl https://<your-worker>.workers.dev/v1/messages \
  -H "Authorization: Bearer <your WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_weather",
        "description": "Get the weather for a given city",
        "input_schema": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "City name" }
          },
          "required": ["city"]
        }
      }
    ],
    "messages": [
      { "role": "user", "content": "What is the weather in London today?" }
    ]
  }'
```

The response includes `tool_use` content blocks:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me check the weather in London." },
    {
      "type": "tool_use",
      "id": "toolu_...",
      "name": "get_weather",
      "input": { "city": "London" }
    }
  ],
  "stop_reason": "tool_use"
}
```

Streaming mode (`"stream": true`) is also fully supported. The SSE event stream includes `content_block_delta` events with `input_json_delta` for tool input, matching native Anthropic API behavior.

## Feature mapping

- Chat maps to upstream `POST /api/chat`.
- Web Search maps to upstream `POST /api/search` when you call `/v1/search`, pass `web_search_options`, pass `query`, or include a web search tool.
- Merge AI maps to upstream `POST /api/merge` when you call `/v1/merge`, pass `merge: true`, or pass `models` with 2+ model IDs.
- Models maps to upstream `GET /api/models` with a fallback catalog if the upstream call fails.
- Files maps upload/extract requests to upstream `POST /api/attachments/extract`; persistent file storage requires adding KV or R2.
- Codex, Agent Setup, and MCP are setup/info endpoints. MCP tool execution remains local to the client agent or IDE.
- Embeddings, audio, and images return `501` because the provided unlimited.surf docs do not expose those native APIs.

## Raw upstream proxy

Any `/api/*` request is forwarded to unlimited.surf with the configured key, so the original API remains available through the Worker.
