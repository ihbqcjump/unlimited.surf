// ═══════════════════════════════════════════════════════════════════════════
// worker.js — Cloudflare Worker for unlimited.surf API relay
// ═══════════════════════════════════════════════════════════════════════════
//
// 来源 / Origin: Based on https://github.com/eooce/transfer-api
//                独立维护的增强版本，不与原版同步。
//                Standalone enhanced version, not synced with original.
//
// 功能 / Purpose:
//   将 unlimited.surf 的 API 转换为 OpenAI/Anthropic 兼容接口。
//   Relay unlimited.surf API into OpenAI/Anthropic-compatible endpoints.
//
// 相比原版的增强 / Enhancements over original:
//   1. anthropicMessages() — 新增 tools 检测，有 tools 时走直连代理
//   2. proxyAnthropicMessages() — 新增函数，直连代理 Anthropic Messages API
//   3. proxyAnthropicStream() — 新增函数，流式 SSE 直连代理
//
//   详见 README.md 中「Tool Calling 支持说明」章节。
//   See README.md "Tool Calling Support" section.
//
// 搜索 "本仓库" 或 "新增函数" 可快速定位所有增强点。
// Search for "本仓库" or "新增函数" to find all enhancement points.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_UPSTREAM_BASE_URL = "https://unlimited.surf";
const DEFAULT_OPENAI_MODEL = "gateway-gpt-5-5";
const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7-20260101";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,x-api-key,anthropic-api-key,anthropic-version,anthropic-beta,openai-beta",
  "Access-Control-Expose-Headers": "content-type,request-id,x-request-id",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    try {
      const authError = validateWorkerApiKey(request, env);
      if (authError) return authError;

      if (path === "/" || path === "/health") {
        return jsonResponse(serviceInfo(request, env));
      }

      if (path.startsWith("/api/")) {
        return proxyUpstream(request, env, path);
      }

      if (path === "/mcp" || path === "/v1/mcp" || path === "/anthropic/mcp" || path === "/anthropic/v1/mcp") {
        return jsonResponse(mcpInfo(request));
      }

      if (path === "/codex" || path === "/v1/codex" || path === "/anthropic/codex" || path === "/anthropic/v1/codex") {
        return textResponse(codexSetup(request), "text/plain; charset=utf-8");
      }

      if (path === "/v1/setup" || path === "/anthropic/setup" || path === "/anthropic/v1/setup") {
        return textResponse(agentSetup(request), "text/plain; charset=utf-8");
      }

      if (path === "/v1/messages" || (path === "/v1/models" && looksLikeAnthropicRequest(request)) || path.startsWith("/anthropic/")) {
        return handleAnthropic(request, env, path);
      }

      if (path.startsWith("/v1/")) {
        return handleOpenAI(request, env, path);
      }

      return errorResponse(404, "not_found", `No route for ${path}`);
    } catch (error) {
      return errorResponse(500, "internal_error", error && error.message ? error.message : String(error));
    }
  },
};

async function handleOpenAI(request, env, path) {
  if ((path === "/v1/key" || path === "/v1/auth-key" || path === "/v1/usage") && request.method === "GET") {
    const rawPath = path === "/v1/usage" ? "/api/usage" : "/api/key";
    return proxyUpstream(request, env, rawPath);
  }

  if (path === "/v1/models" && request.method === "GET") {
    if (looksLikeAnthropicRequest(request)) {
      return anthropicModels(request, env);
    }
    return openAIModels(request, env);
  }

  if (path === "/v1/search" && request.method === "POST") {
    const body = await readJson(request);
    return openAIDirectCapability(request, env, body, "/api/search");
  }

  if (path === "/v1/merge" && request.method === "POST") {
    const body = await readJson(request);
    return openAIDirectCapability(request, env, body, "/api/merge");
  }

  if (path === "/v1/chat/completions" && request.method === "POST") {
    const body = await readJson(request);
    return openAIChatCompletions(request, env, body);
  }

  if (path === "/v1/responses" && request.method === "POST") {
    const body = await readJson(request);
    return openAIResponses(request, env, body);
  }

  if (path === "/v1/files" && request.method === "GET") {
    return jsonResponse({ object: "list", data: [], has_more: false });
  }

  if (path === "/v1/files" && request.method === "POST") {
    return openAIFileUpload(request, env);
  }

  if ((path === "/v1/files/extract" || path === "/v1/attachments/extract") && request.method === "POST") {
    const body = await readJson(request);
    const extracted = await callUnlimitedJson(request, env, "/api/attachments/extract", body);
    return jsonResponse(extracted);
  }

  if (path.startsWith("/v1/files/") && request.method === "GET") {
    return errorResponse(404, "not_found", "This Worker is stateless. Bind KV/R2 if you need persisted OpenAI file retrieval.");
  }

  if (path === "/v1/embeddings" || path.startsWith("/v1/audio/") || path.startsWith("/v1/images/")) {
    return errorResponse(501, "unsupported_endpoint", `${path} is not exposed by unlimited.surf and cannot be emulated faithfully.`);
  }

  return errorResponse(404, "not_found", `Unsupported OpenAI-compatible route ${path}`);
}

async function openAIDirectCapability(request, env, body, route) {
  const model = body.model || env.DEFAULT_MODEL || DEFAULT_OPENAI_MODEL;
  const created = nowSeconds();
  const id = `chatcmpl_${randomId()}`;
  const payload = buildUnlimitedPayload({ ...body, web_search: route === "/api/search", merge: route === "/api/merge" }, route);

  if (body.stream !== false) {
    const upstream = await callUnlimitedStream(request, env, route, payload);
    return sseResponse(streamOpenAIChat(upstream, { id, created, model }));
  }

  const result = await collectUnlimitedText(request, env, route, payload);
  return jsonResponse({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        logprobs: null,
        finish_reason: result.finishReason || "stop",
      },
    ],
    usage: usageFromText(payload.message || payload.query || "", result.text),
    system_fingerprint: `unlimited-surf-worker:${route}`,
  });
}

async function openAIChatCompletions(request, env, body) {
  const model = body.model || env.DEFAULT_MODEL || DEFAULT_OPENAI_MODEL;
  const created = nowSeconds();
  const id = `chatcmpl_${randomId()}`;
  const route = chooseUnlimitedRoute(body);
  const payload = buildUnlimitedPayload(body, route);

  if (body.stream) {
    const upstream = await callUnlimitedStream(request, env, route, payload);
    return sseResponse(streamOpenAIChat(upstream, { id, created, model }));
  }

  const result = await collectUnlimitedText(request, env, route, payload);
  return jsonResponse({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        logprobs: null,
        finish_reason: result.finishReason || "stop",
      },
    ],
    usage: usageFromText(payload.message || "", result.text),
    system_fingerprint: "unlimited-surf-worker",
  });
}

async function openAIResponses(request, env, body) {
  const model = body.model || env.DEFAULT_MODEL || DEFAULT_OPENAI_MODEL;
  const created = nowSeconds();
  const id = `resp_${randomId()}`;
  const syntheticChatBody = responsesToChatBody(body, model);
  const route = chooseUnlimitedRoute(syntheticChatBody);
  const payload = buildUnlimitedPayload(syntheticChatBody, route);

  if (body.stream) {
    const upstream = await callUnlimitedStream(request, env, route, payload);
    return sseResponse(streamOpenAIResponses(upstream, { id, created, model }));
  }

  const result = await collectUnlimitedText(request, env, route, payload);
  return jsonResponse({
    id,
    object: "response",
    created_at: created,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens || body.max_tokens || null,
    model,
    output: [
      {
        id: `msg_${randomId()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: result.text, annotations: [] }],
      },
    ],
    output_text: result.text,
    parallel_tool_calls: true,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || null,
    store: body.store || false,
    temperature: body.temperature || null,
    text: body.text || { format: { type: "text" } },
    tool_choice: body.tool_choice || "auto",
    tools: body.tools || [],
    top_p: body.top_p || null,
    truncation: body.truncation || "disabled",
    usage: responseUsageFromText(payload.message || "", result.text),
    user: body.user || null,
  });
}

async function handleAnthropic(request, env, path) {
  const anthPath = path.startsWith("/anthropic/") ? normalizePath(path.slice("/anthropic".length) || "/") : path;

  if ((anthPath === "/v1/key" || anthPath === "/key" || anthPath === "/v1/auth-key" || anthPath === "/auth-key") && request.method === "GET") {
    return proxyUpstream(request, env, "/api/key");
  }

  if ((anthPath === "/v1/usage" || anthPath === "/usage") && request.method === "GET") {
    return proxyUpstream(request, env, "/api/usage");
  }

  if ((anthPath === "/v1/models" || anthPath === "/models") && request.method === "GET") {
    return anthropicModels(request, env);
  }

  if ((anthPath === "/v1/messages" || anthPath === "/messages") && request.method === "POST") {
    const body = await readJson(request);
    return anthropicMessages(request, env, body);
  }

  if ((anthPath === "/v1/search" || anthPath === "/search") && request.method === "POST") {
    const body = await readJson(request);
    return anthropicDirectCapability(request, env, body, "/api/search");
  }

  if ((anthPath === "/v1/merge" || anthPath === "/merge") && request.method === "POST") {
    const body = await readJson(request);
    return anthropicDirectCapability(request, env, body, "/api/merge");
  }

  if (anthPath === "/v1/setup" || anthPath === "/setup") {
    return textResponse(agentSetup(request), "text/plain; charset=utf-8");
  }

  return errorResponse(404, "not_found", `Unsupported Anthropic-compatible route ${path}`);
}

async function anthropicDirectCapability(request, env, body, route) {
  const requestedModel = body.model || env.DEFAULT_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const payload = buildAnthropicUnlimitedPayload({ ...body, web_search: route === "/api/search", merge: route === "/api/merge" }, route);
  const id = `msg_${randomId()}`;

  if (body.stream !== false) {
    const upstream = await callUnlimitedStream(request, env, route, payload);
    return sseResponse(streamAnthropicMessages(upstream, { id, model: requestedModel }));
  }

  const result = await collectUnlimitedText(request, env, route, payload);
  return jsonResponse({
    id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: [{ type: "text", text: result.text }],
    stop_reason: anthropicStopReason(result.finishReason),
    stop_sequence: null,
    usage: anthropicUsageFromText(payload.message || payload.query || "", result.text),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 【本仓库核心修改】anthropicMessages() — Anthropic Messages 请求入口
// ═══════════════════════════════════════════════════════════════════════════
//
// 原版行为（来自 eooce/transfer-api）：
//   所有 Anthropic Messages 请求都会被转换为纯文本，通过 /api/chat 发送。
//   tools 定义会被序列化成文字描述，模型无法产生 tool_use 响应。
//
// 修改后行为：
//   1. 检测请求体中是否包含 body.tools 数组
//   2. 有 tools → 调用 proxyAnthropicMessages()，将完整请求透传到
//      上游 /v1/messages 端点，保留 Anthropic tool calling 协议
//   3. 无 tools → 走原版文本转换路径（通过 /api/chat），行为不变
//
// Original behavior (from eooce/transfer-api):
//   All Anthropic Messages requests are converted to plain text via /api/chat.
//   Tool definitions are serialized as text descriptions — no tool_use support.
//
// Modified behavior:
//   1. Check if body.tools array is present
//   2. Has tools → proxy directly to upstream /v1/messages via
//      proxyAnthropicMessages(), preserving full tool calling protocol
//   3. No tools → use original text conversion path (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
async function anthropicMessages(request, env, body) {
  // 检测 tools：当请求包含工具定义时，走直连代理路径
  // Detect tools: when tools are present, use the direct proxy path
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return proxyAnthropicMessages(request, env, body);
  }

  // 无 tools 时走原版文本转换路径（以下代码与上游完全一致）
  // No tools: use the original text conversion path (unchanged from upstream)
  const requestedModel = body.model || env.DEFAULT_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const route = chooseUnlimitedRoute(body);
  const payload = buildAnthropicUnlimitedPayload(body, route);
  const id = `msg_${randomId()}`;

  if (body.stream) {
    const upstream = await callUnlimitedStream(request, env, route, payload);
    return sseResponse(streamAnthropicMessages(upstream, { id, model: requestedModel }));
  }

  const result = await collectUnlimitedText(request, env, route, payload);
  return jsonResponse({
    id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: [{ type: "text", text: result.text }],
    stop_reason: anthropicStopReason(result.finishReason),
    stop_sequence: null,
    usage: anthropicUsageFromText(payload.message || "", result.text),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 【新增函数】proxyAnthropicMessages() — 直连代理（非流式 + 流式入口）
// ═══════════════════════════════════════════════════════════════════════════
//
// 当 anthropicMessages() 检测到 tools 后调用此函数。
// 它将完整的 Anthropic Messages API 请求（包括 tools、messages、system 等）
// 原封不动地代理到上游 unlimited.surf 的 /v1/messages 端点。
//
// 为什么需要这个函数？
//   原版的文本转换路径会丢失 tool calling 信息：
//   - tools 定义被序列化为纯文本 → 模型不知道有工具可用
//   - 上游 /api/chat 不返回 tool_use 内容块 → 无法实现工具调用循环
//   直连 /v1/messages 端点可以完整保留 Anthropic 协议的所有特性。
//
// This function is called when anthropicMessages() detects tools in the request.
// It proxies the full Anthropic Messages API request (tools, messages, system, etc.)
// as-is to upstream unlimited.surf's /v1/messages endpoint.
// ═══════════════════════════════════════════════════════════════════════════
async function proxyAnthropicMessages(request, env, body) {
  const upstreamUrl = new URL("/v1/messages", upstreamBase(env));

  // 获取上游 API key（优先用环境变量中的 UNLIMITED_SURF_API_KEY）
  // Get the upstream API key (prefers UNLIMITED_SURF_API_KEY from env)
  const key = upstreamApiKey(request, env);

  // 构建 Anthropic Messages API 请求头
  // Build headers for the Anthropic Messages API
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${key}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");

  // 透传 Anthropic 特有请求头（版本号和 beta 特性标记）
  // Forward Anthropic-specific headers from the original request
  const anthropicVersion = request.headers.get("anthropic-version");
  if (anthropicVersion) headers.set("anthropic-version", anthropicVersion);
  else headers.set("anthropic-version", "2023-06-01");

  const anthropicBeta = request.headers.get("anthropic-beta");
  if (anthropicBeta) headers.set("anthropic-beta", anthropicBeta);

  // 请求体原封不动转发——保留 tools、messages、system 等所有字段
  // Forward the request body as-is, preserving tools, messages, etc.
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };

  // 流式请求走 proxyAnthropicStream()，它直接透传 SSE 事件流
  // Streaming requests go through proxyAnthropicStream() which passes SSE events directly
  if (body.stream) {
    return proxyAnthropicStream(upstreamUrl, init);
  }

  // 非流式：代理完整的 JSON 响应（包括 tool_use 内容块）
  // Non-streaming: proxy the full JSON response (including tool_use content blocks)
  const response = await fetch(upstreamUrl, init);

  if (!response.ok) {
    const errorText = await response.text();
    return errorResponse(response.status, "upstream_error", `Upstream Anthropic API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return addCors(jsonResponse(data));
}

// ═══════════════════════════════════════════════════════════════════════════
// 【新增函数】proxyAnthropicStream() — 流式 SSE 直连代理
// ═══════════════════════════════════════════════════════════════════════════
//
// 将上游 unlimited.surf /v1/messages 返回的 SSE 事件流直接透传给客户端。
// 不做任何解析或转换，只做数据分块转发。
//
// 上游返回的 SSE 事件包含（Anthropic 标准格式）：
//   event: message_start        → 消息开始
//   event: content_block_start  → 内容块开始（可能是 text 或 tool_use 类型）
//   event: content_block_delta  → 增量内容
//     - text_delta: 文本增量
//     - input_json_delta: 工具输入参数增量（tool calling 关键事件）
//   event: content_block_stop   → 内容块结束
//   event: message_delta        → 消息级元数据（如 stop_reason、usage）
//   event: message_stop         → 消息结束
//
// 实现要点：
//   - 使用 ReadableStream 逐块读取上游响应
//   - 按空行分割 SSE 事件（SSE 标准：空行表示事件边界）
//   - 多行事件（event: + data: + ...）作为一个整体转发
//   - 错误时发送 error 事件而非断开连接
//
// This function passes through SSE events from upstream /v1/messages directly.
// No parsing or transformation — just chunked forwarding of the event stream.
// Key SSE events for tool calling include content_block_delta with input_json_delta.
// ═══════════════════════════════════════════════════════════════════════════
async function proxyAnthropicStream(upstreamUrl, init) {
  const response = await fetch(upstreamUrl, init);

  if (!response.ok) {
    const errorText = await response.text();
    return errorResponse(response.status, "upstream_error", `Upstream Anthropic API error: ${response.status} ${errorText}`);
  }

  // 直接透传上游 SSE 流——不做任何解析或转换
  // Directly pass through the SSE stream — no parsing or transformation
  // 上游已经返回标准 Anthropic SSE 事件（包括 tool_use 相关事件）
  // The upstream already returns proper Anthropic SSE events (including tool_use events)
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // 按换行分割（兼容 \r\n 和 \n）
          // Split by newline (handles both \r\n and \n)
          const lines = buffer.split(/\r?\n/);
          // 最后一行可能不完整，留在 buffer 中等待下一个 chunk
          // Last line may be incomplete, keep in buffer for next chunk
          buffer = lines.pop() || "";

          // 按 SSE 标准转发完整事件（空行 = 事件边界）
          // Forward complete SSE events per spec (empty line = event boundary)
          let eventBuffer = "";
          for (const line of lines) {
            eventBuffer += line + "\n";
            if (line === "") {
              // 空行 = SSE 事件结束，将整个事件（可能多行）一次性转发
              // Empty line = end of SSE event, flush the whole event (may be multi-line)
              controller.enqueue(encoder.encode(eventBuffer));
              eventBuffer = "";
            }
          }
          // 如果 eventBuffer 还有内容（不完整事件），合并回 buffer 等待下次处理
          // If eventBuffer has content (incomplete event), merge back into buffer
          if (eventBuffer) {
            buffer = eventBuffer + buffer;
          }
        }
        // 流结束时刷新剩余缓冲区
        // Flush remaining buffer at stream end
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(buffer));
        }
        controller.close();
      } catch (error) {
        // 错误时发送 error SSE 事件，避免客户端挂起
        // On error, send an error SSE event to avoid client hanging
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: error.message || String(error) } })}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function anthropicModels(request, env) {
  const catalog = await getModelCatalog(request, env);
  const claudeModels = catalog
    .filter((model) => /claude|anthropic/i.test(`${model.id} ${model.name || ""} ${model.provider || ""}`))
    .map((model) => toAnthropicModel(model));

  return jsonResponse({
    data: claudeModels.length ? claudeModels : [toAnthropicModel({ id: DEFAULT_CLAUDE_MODEL, name: "Claude Opus 4.7" })],
    has_more: false,
    first_id: claudeModels[0] ? claudeModels[0].id : DEFAULT_CLAUDE_MODEL,
    last_id: claudeModels[claudeModels.length - 1] ? claudeModels[claudeModels.length - 1].id : DEFAULT_CLAUDE_MODEL,
  });
}

async function openAIModels(request, env) {
  const catalog = await getModelCatalog(request, env);
  return jsonResponse({
    object: "list",
    data: catalog.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.provider || "unlimited.surf",
      permission: [],
      root: model.id,
      parent: null,
    })),
  });
}

async function openAIFileUpload(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return errorResponse(400, "invalid_request_error", "OpenAI file upload expects multipart/form-data with a file field.");
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return errorResponse(400, "invalid_request_error", "Missing multipart file field named file.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const payload = {
    name: file.name || "upload.bin",
    type: file.type || "application/octet-stream",
    data: bytesToBase64(bytes),
  };
  const extracted = await callUnlimitedJson(request, env, "/api/attachments/extract", payload);
  const id = `file_${randomId()}`;
  return jsonResponse({
    id,
    object: "file",
    bytes: bytes.byteLength,
    created_at: nowSeconds(),
    filename: payload.name,
    purpose: form.get("purpose") || "assistants",
    status: extracted && extracted.success === false ? "error" : "processed",
    status_detail: null,
    unlimited_extract: extracted,
  });
}

function chooseUnlimitedRoute(body) {
  if (body.models && Array.isArray(body.models) && body.models.length >= 2) return "/api/merge";
  if (body.merge || body.merge_ai) return "/api/merge";
  if (body.query || body.web_search || body.web_search_options || hasWebSearchTool(body.tools)) return "/api/search";
  return "/api/chat";
}

function buildUnlimitedPayload(body, route) {
  if (route === "/api/search") {
    return {
      query: body.query || latestUserText(body.messages) || inputToText(body.input) || body.prompt || "",
      model: mapUpstreamModel(body.model),
      effort: body.effort || reasoningEffort(body),
    };
  }

  const message = body.message || messagesToText(body.messages) || inputToText(body.input) || body.prompt || "";
  const payload = {
    message,
    model: mapUpstreamModel(body.model),
    effort: body.effort || reasoningEffort(body),
  };

  if (route === "/api/merge") {
    payload.models = Array.isArray(body.models) && body.models.length ? body.models.map(mapUpstreamModel) : undefined;
  }

  return payload;
}

function buildAnthropicUnlimitedPayload(body, route) {
  if (route === "/api/search") {
    return {
      query: latestUserText(body.messages) || body.query || "",
      model: mapUpstreamModel(body.model),
      effort: body.effort || reasoningEffort(body),
    };
  }

  const prompt = anthropicMessagesToText(body);
  const payload = {
    message: prompt,
    model: mapUpstreamModel(body.model),
    effort: body.effort || reasoningEffort(body),
  };

  if (route === "/api/merge") {
    payload.models = Array.isArray(body.models) && body.models.length ? body.models.map(mapUpstreamModel) : undefined;
  }

  return payload;
}

function responsesToChatBody(body, fallbackModel) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const inputText = inputToText(body.input);
  if (inputText) messages.push({ role: "user", content: inputText });

  return {
    ...body,
    model: body.model || fallbackModel,
    messages,
    stream: body.stream,
  };
}

async function proxyUpstream(request, env, path) {
  const upstreamUrl = new URL(path + new URL(request.url).search, upstreamBase(env));
  const headers = new Headers(request.headers);
  const key = optionalUpstreamApiKey(request, env);
  if (key) headers.set("authorization", `Bearer ${key}`);
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  };

  const response = await fetch(upstreamUrl, init);
  return addCors(response);
}

async function callUnlimitedJson(request, env, path, payload) {
  const response = await fetch(new URL(path, upstreamBase(env)), {
    method: "POST",
    headers: upstreamHeaders(request, env, false),
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    throw new Error(`upstream ${path} failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function callUnlimitedStream(request, env, path, payload) {
  const response = await fetch(new URL(path, upstreamBase(env)), {
    method: "POST",
    headers: upstreamHeaders(request, env, true),
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    throw new Error(`upstream ${path} failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

async function collectUnlimitedText(request, env, path, payload) {
  const response = await callUnlimitedStream(request, env, path, payload);
  const events = await readUnlimitedEvents(response);
  let text = "";
  let finishReason = "stop";
  const annotations = [];

  for (const event of events) {
    if (typeof event.delta === "string") text += event.delta;
    if (event.results) annotations.push(event.results);
    if (event.finish && event.reason) finishReason = event.reason;
  }

  return { text, finishReason, annotations, rawEvents: events };
}

async function getModelCatalog(request, env) {
  try {
    const headers = new Headers();
    const key = optionalUpstreamApiKey(request, env);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const response = await fetch(new URL("/api/models", upstreamBase(env)), { headers });
    if (!response.ok) throw new Error(`models failed: ${response.status}`);
    const data = await response.json();
    const models = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    return models.map((model) => ({
      id: model.id || model.name || String(model),
      name: model.name || model.id || String(model),
      provider: model.provider || providerFromModel(model.id || model.name || ""),
      tier: model.tier || undefined,
    })).filter((model) => model.id);
  } catch (_) {
    return fallbackModels();
  }
}

function streamOpenAIChat(upstream, meta) {
  return streamUnlimitedEvents(upstream, {
    start(controller) {
      writeSse(controller, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    },
    delta(controller, text) {
      writeSse(controller, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    },
    finish(controller, reason) {
      writeSse(controller, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: {}, finish_reason: openAIStopReason(reason) }],
      });
      writeRawSse(controller, "data: [DONE]\n\n");
    },
  });
}

function streamOpenAIResponses(upstream, meta) {
  const outputId = `msg_${randomId()}`;
  return streamUnlimitedEvents(upstream, {
    start(controller) {
      writeSseEvent(controller, "response.created", {
        type: "response.created",
        response: {
          id: meta.id,
          object: "response",
          created_at: meta.created,
          status: "in_progress",
          model: meta.model,
          output: [],
        },
      });
      writeSseEvent(controller, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: outputId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      writeSseEvent(controller, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    },
    delta(controller, text) {
      writeSseEvent(controller, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
    },
    finish(controller) {
      writeSseEvent(controller, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        text: "",
      });
      writeSseEvent(controller, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      writeSseEvent(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: outputId, type: "message", status: "completed", role: "assistant", content: [] },
      });
      writeSseEvent(controller, "response.completed", {
        type: "response.completed",
        response: { id: meta.id, object: "response", created_at: meta.created, status: "completed", model: meta.model },
      });
      writeRawSse(controller, "data: [DONE]\n\n");
    },
  });
}

function streamAnthropicMessages(upstream, meta) {
  return streamUnlimitedEvents(upstream, {
    start(controller) {
      writeSseEvent(controller, "message_start", {
        type: "message_start",
        message: {
          id: meta.id,
          type: "message",
          role: "assistant",
          model: meta.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      writeSseEvent(controller, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    },
    delta(controller, text) {
      writeSseEvent(controller, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    },
    finish(controller, reason) {
      writeSseEvent(controller, "content_block_stop", { type: "content_block_stop", index: 0 });
      writeSseEvent(controller, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: anthropicStopReason(reason), stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      writeSseEvent(controller, "message_stop", { type: "message_stop" });
    },
  });
}

function streamUnlimitedEvents(upstream, handlers) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      let finished = false;
      handlers.start && handlers.start(controller);

      try {
        const reader = upstream.body.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const parsed = parseSseJson(line.slice(5).trim());
            if (!parsed) continue;

            if (typeof parsed.delta === "string" && parsed.delta.length) {
              handlers.delta && handlers.delta(controller, parsed.delta, parsed);
            }

            if (parsed.finish || parsed.done) {
              finished = true;
              handlers.finish && handlers.finish(controller, parsed.reason || "stop", parsed);
            }
          }
        }

        if (!finished) handlers.finish && handlers.finish(controller, "stop", {});
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: error.message || String(error) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

async function readUnlimitedEvents(response) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const events = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const parsed = parseSseJson(line.slice(5).trim());
      if (parsed) events.push(parsed);
    }
  }

  if (buffer.startsWith("data:")) {
    const parsed = parseSseJson(buffer.slice(5).trim());
    if (parsed) events.push(parsed);
  }

  return events;
}

function writeSse(controller, data) {
  writeRawSse(controller, `data: ${JSON.stringify(data)}\n\n`);
}

function writeSseEvent(controller, event, data) {
  writeRawSse(controller, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeRawSse(controller, chunk) {
  controller.enqueue(new TextEncoder().encode(chunk));
}

function sseResponse(body) {
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function textResponse(text, contentType, init = {}) {
  return new Response(text, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function errorResponse(status, code, message) {
  return jsonResponse({
    error: {
      message,
      type: code,
      code,
    },
  }, { status });
}

function addCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readJson(request) {
  if (!request.body) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("Request body must be valid JSON.");
  }
}

function upstreamHeaders(request, env, wantsStream) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${upstreamApiKey(request, env)}`);
  headers.set("Content-Type", "application/json");
  if (wantsStream) headers.set("Accept", "text/event-stream");
  return headers;
}

function upstreamApiKey(request, env) {
  const key = optionalUpstreamApiKey(request, env);
  if (key) return key;

  if (env.WORKER_API_KEY) {
    throw new Error("Missing upstream API key. Set UNLIMITED_SURF_API_KEY when WORKER_API_KEY is enabled.");
  }

  throw new Error("Missing upstream API key. Set UNLIMITED_SURF_API_KEY or pass Authorization: Bearer <key> / x-api-key: <key>.");
}

function optionalUpstreamApiKey(request, env) {
  const configured = env.UNLIMITED_SURF_API_KEY || env.API_KEY || env.AUTH_KEY;
  if (configured) return configured;

  if (env.WORKER_API_KEY) return "";

  return clientApiKey(request);
}

function validateWorkerApiKey(request, env) {
  const expected = env.WORKER_API_KEY;
  if (!expected) return null;

  const actual = clientApiKey(request);
  if (actual && constantTimeEqual(actual, expected)) return null;

  return jsonResponse({
    error: {
      message: "Invalid or missing Worker API key.",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}

function clientApiKey(request) {
  const auth = request.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();

  const xKey = request.headers.get("x-api-key") || request.headers.get("anthropic-api-key");
  return xKey ? xKey.trim() : "";
}

function constantTimeEqual(actual, expected) {
  const actualText = String(actual || "");
  const expectedText = String(expected || "");
  if (actualText.length !== expectedText.length) return false;

  let diff = 0;
  for (let i = 0; i < actualText.length; i += 1) {
    diff |= actualText.charCodeAt(i) ^ expectedText.charCodeAt(i);
  }
  return diff === 0;
}

function upstreamBase(env) {
  return stripTrailingSlash(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL) + "/";
}

function normalizePath(path) {
  if (!path || path === "") return "/";
  const normalized = path.replace(/\/+/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function messagesToText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    const role = message.role || "user";
    return `${role}: ${contentToText(message.content)}`;
  }).filter(Boolean).join("\n\n");
}

function anthropicMessagesToText(body) {
  const parts = [];
  if (body.system) parts.push(`system: ${contentToText(body.system)}`);
  if (Array.isArray(body.tools) && body.tools.length) {
    parts.push(`available tools: ${JSON.stringify(body.tools)}`);
    parts.push("If a tool is required, describe the intended tool call clearly. MCP and local tools must be executed by the client agent.");
  }
  if (Array.isArray(body.messages)) parts.push(messagesToText(body.messages));
  return parts.filter(Boolean).join("\n\n");
}

function inputToText(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return contentToText(input);

  return input.map((item) => {
    if (typeof item === "string") return item;
    if (item.type === "message") return `${item.role || "user"}: ${contentToText(item.content)}`;
    if (item.role) return `${item.role}: ${contentToText(item.content)}`;
    if (item.type === "input_text" || item.type === "output_text") return item.text || "";
    return contentToText(item);
  }).filter(Boolean).join("\n\n");
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => contentToText(part)).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.input_text === "string") return content.input_text;
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (content.type === "input_text" && typeof content.text === "string") return content.text;
    if (content.type === "image_url") return `[image: ${content.image_url && content.image_url.url ? content.image_url.url : "attached"}]`;
    if (content.type === "image") return "[image attached]";
    if (content.type === "tool_result") return `[tool_result ${content.tool_use_id || ""}] ${contentToText(content.content)}`;
    if (content.type === "tool_use") return `[tool_use ${content.name || "tool"}] ${JSON.stringify(content.input || {})}`;
    if (content.type) return `[${content.type}] ${JSON.stringify(content)}`;
  }
  return String(content);
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i].role || "user") === "user") return contentToText(messages[i].content);
  }
  return "";
}

function hasWebSearchTool(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    const type = tool && (tool.type || tool.name || (tool.function && tool.function.name));
    return /web.?search|browser|search/i.test(String(type || ""));
  });
}

function reasoningEffort(body) {
  if (body.effort) return body.effort;
  if (typeof body.reasoning_effort === "string") return body.reasoning_effort;
  if (body.reasoning && typeof body.reasoning.effort === "string") return body.reasoning.effort;
  return "medium";
}

function mapUpstreamModel(model) {
  if (!model) return DEFAULT_OPENAI_MODEL;
  if (model.startsWith("gateway-")) return model;
  if (/^claude-/i.test(model)) return `gateway-${model.replace(/-\d{8}$/, "")}`;
  if (/^gpt-/i.test(model)) return `gateway-${model}`;
  if (/^gemini-/i.test(model)) return `gateway-google-${model.replace(/^gemini-/i, "")}`;
  return model;
}

function toAnthropicModel(model) {
  const id = model.id.startsWith("gateway-") ? model.id.replace(/^gateway-/, "") : model.id;
  const versioned = /^claude-.*-\d{8}$/.test(id) ? id : anthropicVersionedId(id);
  return {
    id: versioned,
    type: "model",
    display_name: model.name || versioned,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function anthropicVersionedId(id) {
  if (/^claude-/i.test(id)) return `${id}-20260101`;
  return id;
}

function providerFromModel(model) {
  if (/claude|anthropic/i.test(model)) return "anthropic";
  if (/gemini|google/i.test(model)) return "google";
  if (/gpt|openai/i.test(model)) return "openai";
  return "unlimited.surf";
}

function fallbackModels() {
  return [
    { id: "gateway-gpt-5", name: "GPT-5", provider: "openai", tier: "flagship" },
    { id: "gateway-gpt-5-1", name: "GPT-5.1", provider: "openai", tier: "flagship" },
    { id: "gateway-claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic", tier: "flagship" },
    { id: "gateway-google-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", tier: "flagship" },
    { id: "gateway-gemini-3-flash", name: "Gemini 3 Flash", provider: "google", tier: "fast" },
  ];
}

function parseSseJson(data) {
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

function openAIStopReason(reason) {
  if (!reason) return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return reason === "end_turn" ? "stop" : reason;
}

function anthropicStopReason(reason) {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return reason;
}

function usageFromText(input, output) {
  const promptTokens = estimateTokens(input);
  const completionTokens = estimateTokens(output);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function responseUsageFromText(input, output) {
  const inputTokens = estimateTokens(input);
  const outputTokens = estimateTokens(output);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function anthropicUsageFromText(input, output) {
  return { input_tokens: estimateTokens(input), output_tokens: estimateTokens(output) };
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function looksLikeAnthropicRequest(request) {
  return request.headers.has("anthropic-version") || request.headers.has("anthropic-beta") || request.headers.has("x-api-key");
}

function serviceInfo(request, env) {
  const origin = new URL(request.url).origin;
  return {
    ok: true,
    service: "unlimited.surf OpenAI/Anthropic compatibility Worker",
    upstream: stripTrailingSlash(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL),
    routes: {
      raw: `${origin}/api/chat, /api/search, /api/merge, /api/models, /api/key, /api/attachments/extract`,
      openai: `${origin}/v1/chat/completions, /v1/responses, /v1/models, /v1/files`,
      anthropic: `${origin}/v1/messages or ${origin}/anthropic/v1/messages`,
      setup: `${origin}/v1/setup, /v1/codex, /v1/mcp`,
    },
  };
}

function agentSetup(request) {
  const origin = new URL(request.url).origin;
  return `Claude Code / Anthropic-compatible setup

PowerShell:
$env:ANTHROPIC_BASE_URL = "${origin}"
$env:ANTHROPIC_AUTH_TOKEN = "<your unlimited.surf key>"
$env:ANTHROPIC_API_KEY = "<your unlimited.surf key>"
$env:ANTHROPIC_MODEL = "${DEFAULT_CLAUDE_MODEL}"
claude

Bash:
export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="<your unlimited.surf key>"
export ANTHROPIC_API_KEY="<your unlimited.surf key>"
export ANTHROPIC_MODEL="${DEFAULT_CLAUDE_MODEL}"
claude

Goose / Hermes / other agents:
Provider: Anthropic-compatible
Base URL: ${origin}
API key: <your unlimited.surf key>
Model: ${DEFAULT_CLAUDE_MODEL}

Messages endpoint: POST ${origin}/v1/messages
Models endpoint: GET ${origin}/v1/models

MCP tools run in the client/agent environment. Use this Worker as the model endpoint, then configure MCP servers in your IDE or agent.
`;
}

function codexSetup(request) {
  const origin = new URL(request.url).origin;
  return `Codex custom provider notes

OpenAI-compatible Chat Completions:
base_url = "${origin}/v1"
api_key = "<your unlimited.surf key>"
model = "${DEFAULT_OPENAI_MODEL}"

OpenAI Responses-compatible route for newer agents:
POST ${origin}/v1/responses

Direct smoke test:
curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer <your unlimited.surf key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${DEFAULT_OPENAI_MODEL}","messages":[{"role":"user","content":"Write a small test function."}],"stream":true}'

Anthropic-compatible agent route:
POST ${origin}/v1/messages

MCP execution remains client-side; configure MCP servers in Codex or your IDE, and point the model provider at this Worker.
`;
}

function mcpInfo(request) {
  const origin = new URL(request.url).origin;
  return {
    supported: true,
    model_endpoint: origin,
    note: "MCP servers execute inside the client or agent. This Worker supplies OpenAI/Anthropic-compatible model endpoints and does not run local MCP tools in the browser or edge runtime.",
    endpoints: {
      openai_responses: `${origin}/v1/responses`,
      openai_chat_completions: `${origin}/v1/chat/completions`,
      anthropic_messages: `${origin}/v1/messages`,
      setup: `${origin}/v1/setup`,
    },
  };
}
