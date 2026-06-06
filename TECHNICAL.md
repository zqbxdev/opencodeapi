# OpenCodeAPI 技术架构文档

本文档详细介绍了 `opencodeapi` 代理服务的架构设计、API 逆向分析实现、协议格式转换机制，以及高并发网络连接的中断与回收机制。

---

## 1. 架构概览

`opencodeapi` 作为一个中转反向代理，采用 Node.js/Express 构建，使用 Bun 运行时执行。其核心职责是将标准的 OpenAI 聊天补全请求翻译成 OpenCode 云端接口能够理解的格式，并高效地传输流式或非流式响应。

### 模块结构
```text
opencodeapi/
├── index.js                  # 入口服务，加载 Express 并初始化路由和全局状态
└── src/
    ├── config.js             # 配置中心，包含云端/本地模型定义、时效缓存、终端 Header 定义
    ├── executor.js           # 逆向网络执行器，负责云端发起调用、协议转换 (OpenAI <-> Anthropic)
    └── routes/
        ├── models.js         # GET /v1/models 路由，提供动态的模型列表获取
        └── chat.js           # POST /v1/chat/completions 路由，处理高并发的流式与非流式代理
```

---

## 2. API 逆向与凭证伪装

OpenCode 官方通过在桌面客户端（Desktop TUI / Plugin）中配置一组特定的免密公共通道，以满足用户基础功能的快速体验。`opencodeapi` 提取并模拟了该通道的所有请求特征：

* **Base URL**：所有的接口访问均指向 `https://opencode.ai`。
* **认证授权 (Authorization)**：云端接受一个公共标识令牌 `Bearer public`。
* **设备伪装 (Device Impersonation)**：必须携带 `x-opencode-client: desktop` 标头，告知云端这是一个官方的终端客户端，以避免由于跨域或未知来源导致的拦截。
* **数据流设定**：设置 `Accept: text/event-stream` 来维持持久连接。

---

## 3. 协议适配与双向格式转换

OpenCode 平台在后端接入了多种不同的底层推理引擎，不同接口支持的协议格式不同：
1. **OpenAI Chat Completions 兼容路径**：`/zen/v1/chat/completions`。
2. **Anthropic Messages 兼容路径**：`/zen/v1/messages` (目前如测试模型 `big-pickle` 使用该路径)。

为了让客户端能够使用标准的 OpenAI 协议请求这两种类型的模型，`opencodeapi` 在 `src/executor.js` 中实现了全自动的协议翻译：

### 3.1 请求格式转化 (Request Normalization)
当检测到目标模型属于 Anthropic Messages 协议格式时，执行器会将 OpenAI 格式的请求体转化为符合 Anthropic 格式的 Payload：
* **Role 映射**：将 OpenAI 消息中的 `system` 角色降级/合并为 `user`，因为 Anthropic 协议对系统提示词的位置有严格限制。
* **内容格式转换**：如果输入消息 `content` 是复杂数组对象，自动提取所有文本类型块并用换行拼接为单一文本。
* **强制参数**：自动附加必填项 `max_tokens: 4096` 以防报错。

### 3.2 流式分块翻译 (Streaming Chunks Normalization)
这是协议翻译中最复杂的环节。由于上游返回的 SSE（Server-Sent Events）事件结构大相径庭，执行器需要截获并重组分块：
* **Anthropic 启动阶段 (`message_start`)**：转换为 OpenAI 首包特征（包含模型名称、创建时间戳并初始化 `choices[0].delta` 结构）。
* **数据传输阶段 (`content_block_delta`)**：提取包含在 `delta.text` 中的增量文本，重组并输出 OpenAI 标准分块 `{"choices":[{"delta":{"content":"..."}}]}`。
* **完成阶段 (`message_delta` / `message_stop`)**：捕获 Anthropic 的 `stop_reason`，翻译成 OpenAI 统一的 `finish_reason` (例如 `"stop"`) 并宣告流结束。

---

## 4. 动态发现与缓存同步算法

为保证模型列表的实时性，服务未采用静态写死的方式，而是设计了一套**动态拉取 + 1小时 TTL 缓存储存**机制：

```text
               ┌───────────────────────┐
               │    Get Models Req     │
               └───────────┬───────────┘
                           │
                 [Cache Hit & Valid?]
                  /             \
                YES              NO
                /                 \
     ┌───────────────────┐    ┌───────────────────────────────┐
     │ Return from Cache │    │ Fetch From OpenCode Zen API   │
     └───────────────────┘    └───────────────┬───────────────┘
                                              │
                                       [Fetch Success?]
                                       /              \
                                     YES               NO
                                     /                  \
                        ┌──────────────────┐      ┌─────────────────────────┐
                        │ Parse Free List  │      │ Catch Error & Log       │
                        │ & Update Cache   │      │ Fallback to Static List │
                        └──────────────────┘      └─────────────────────────┘
```

1. **缓存判定**：每次访问 `/v1/models` 时，系统先检测当前内存中是否已有缓存以及缓存是否已存活超过 1 小时。
2. **过滤模型**：当发起请求且请求成功时，从官方的 40+ 模型中，只筛选出模型 ID 包含 `-free` 后缀以及已被标记为免费的隐身测试模型。
3. **安全降级**：若发生网络超时或获取失败，自动捕获异常并加载项目内置的静态兜底列表（`STATIC_FALLBACK_MODELS`），从而最大限度保证服务接口的可用性与容错能力。

---

## 5. 高并发连接释放与 Abort 传播机制

在高并发场景下，如果客户端不断发起请求并迅速中途关闭，服务器的 CPU、套接字（Socket）和内存很容易因为挂起连接而耗尽。`opencodeapi` 通过在路由控制器和底层 Fetch 中构建中断传播链解决了此问题：

1. **精确监听响应生命周期**：
   在 Express 的流处理器中，我们监听了 `res.on("close")` 事件。此事件在连接完全终止、客户端主动取消或网络异常中断时可靠触发。
2. **中止请求传播**：
   当 `close` 事件捕获到客户端断开后，立刻调用内部的 `abortController.abort()`。
3. **上游 Fetch 级联中止**：
   我们在底层使用支持标准的 `AbortSignal` 的 `fetch`，当 `abortController` 被激活时，上游尚未完成的 `fetch` 连接会被强制关闭（Cloudflare 和 OpenCode 端的连接会被直接 Reset 并释放端口）。
4. **中断流读取循环**：
   在 while 循环的顶部设置检查点 `if (abortController.signal.aborted) break;`。在读取发生异常前优雅退出循环并释放 Reader 内存。

这套逻辑不仅消除了僵尸连接，还极大减少了在不稳定网络下的带宽占用，保证了其生产级别的吞吐性能。
