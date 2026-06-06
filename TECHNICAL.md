# OpenCodeAPI 技术架构文档

本文档面向维护者，说明 `opencodeapi` 的运行架构、上游协议适配、模型发现缓存、连接中止传播，以及 Docker/GitHub Actions 发布链路。

---

## 1. 系统定位

`opencodeapi` 是一个 OpenAI-compatible 反向代理服务。它对外暴露标准 OpenAI 风格接口，对内调用 OpenCode 的云端 Zen API，并负责在不同上游协议之间做请求与响应转换。

核心目标：

1. 让客户端以统一的 OpenAI API 方式访问 OpenCode 免费模型。
2. 自动发现上游新增免费模型，减少手动维护成本。
3. 支持 SSE 流式转发，并在客户端断开后及时释放上游连接。
4. 提供容器化部署与 tag-triggered 镜像发布流程。

---

## 2. 项目结构

```text
opencodeapi/
├── .github/
│   └── workflows/
│       └── docker-publish.yml   # Git tag 触发 Docker 镜像构建与推送
├── Dockerfile                   # Bun Alpine 生产镜像构建文件
├── README.md                    # 使用文档
├── TECHNICAL.md                 # 技术文档
├── example.js                   # SSE 调用示例
├── index.js                     # Express 服务入口
├── package.json                 # 项目依赖与脚本
├── test-stress.js               # 并发压测脚本
└── src/
    ├── config.js                # 上游地址、Header、模型发现、缓存与 fallback
    ├── executor.js              # 上游请求执行器与协议转换层
    └── routes/
        ├── chat.js              # POST /v1/chat/completions
        └── models.js            # GET /v1/models
```

---

## 3. 请求链路

### 3.1 模型列表请求

```text
Client
  │
  │ GET /v1/models
  ▼
routes/models.js
  │
  │ getFreeModels()
  ▼
config.js
  │
  ├─ cache hit  ─────────────► return cached OpenAI model list
  │
  └─ cache miss
        │
        ▼
    fetch https://opencode.ai/zen/v1/models
        │
        ├─ success ─► filter free models ─► update 1h cache ─► return
        │
        └─ failure ─► return STATIC_FALLBACK_MODELS
```

### 3.2 聊天补全请求

```text
Client
  │
  │ POST /v1/chat/completions
  ▼
routes/chat.js
  │
  ├─ validate requested model
  ├─ create AbortController
  ├─ bind res.on("close") to abort upstream fetch
  │
  ▼
executor.js
  │
  ├─ resolve upstream endpoint by model/protocol
  ├─ normalize request payload if needed
  ├─ fetch OpenCode Zen API
  └─ normalize response chunks/body back to OpenAI format
```

---

## 4. 上游 API 访问特征

服务访问 OpenCode 上游时会模拟 OpenCode 客户端的公共请求通道。

关键请求特征：

| 项目 | 值 |
|---|---|
| Base URL | `https://opencode.ai` |
| Chat endpoint | `/zen/v1/chat/completions` |
| Messages endpoint | `/zen/v1/messages` |
| Models endpoint | `/zen/v1/models` |
| Authorization | `Bearer public` |
| Client header | `x-opencode-client: desktop` |
| Streaming Accept | `text/event-stream` |

这些 Header 和 endpoint 统一由 `src/config.js` 维护，避免在业务路由中重复硬编码。

---

## 5. 模型发现与过滤策略

服务不会只依赖静态模型清单，而是优先动态获取 OpenCode 云端模型列表。

### 5.1 缓存策略

- 缓存位置：进程内存。
- 缓存有效期：1 小时。
- 缓存对象：过滤后的免费模型列表。
- 失效条件：当前时间超过 `lastFetchTime + CACHE_TTL`。

### 5.2 免费模型过滤

当前逻辑会保留：

1. 模型 ID 包含 `-free` 的模型。
2. 已确认可通过公共通道访问的隐藏/测试免费模型，例如：
   - `big-pickle`
   - `grok-code`
   - `gpt-5-nano`

### 5.3 Fallback 策略

当 `/zen/v1/models` 请求失败时，服务会返回 `STATIC_FALLBACK_MODELS`，避免 `/v1/models` 直接不可用。

这类失败包括：

- DNS 解析失败。
- 上游短暂不可用。
- 网络超时。
- 上游返回非预期结构。

---

## 6. 协议适配层

OpenCode 后端可能对不同模型使用不同接口协议。`opencodeapi` 的外部接口始终保持 OpenAI-compatible，由 `executor.js` 在内部做转换。

### 6.1 OpenAI Chat Completions 路径

大多数模型使用：

```text
POST https://opencode.ai/zen/v1/chat/completions
```

该路径与 OpenAI Chat Completions 结构接近，因此主要做透传与错误规范化。

### 6.2 Anthropic Messages 路径

部分模型使用：

```text
POST https://opencode.ai/zen/v1/messages
```

这类模型需要额外转换。

请求转换重点：

- 将 OpenAI `messages` 转为 Anthropic `messages`。
- 处理 `system` 消息位置差异。
- 将复杂 content block 合并为文本。
- 自动补充 `max_tokens`。

流式响应转换重点：

| Anthropic SSE 事件 | OpenAI SSE 转换 |
|---|---|
| `message_start` | 初始化 `chat.completion.chunk` |
| `content_block_delta` | 转成 `choices[0].delta.content` |
| `message_delta` | 转成带 `finish_reason` 的 chunk |
| `message_stop` | 输出 `data: [DONE]` |

---

## 7. SSE 流式转发与连接中止

流式请求使用 SSE：

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

### 7.1 为什么监听 `res.on("close")`

服务端需要知道客户端何时真正断开连接。实践中，监听 `req.on("close")` 可能在请求体读取完成后过早触发，尤其是 Express + JSON body parser 场景。因此本项目使用：

```js
res.on("close", () => {
  abortController.abort();
});
```

`res` 的 close 更能代表响应通道已关闭，适合用于 SSE 生命周期管理。

### 7.2 Abort 传播链

```text
Client disconnect
  │
  ▼
res close event
  │
  ▼
AbortController.abort()
  │
  ▼
fetch(..., { signal })
  │
  ▼
upstream connection cancelled
```

这样可以避免：

- 客户端已断开但上游仍在生成。
- 服务器维持无效 socket。
- 并发测试时产生大量僵尸连接。
- 不必要的上游带宽消耗。

---

## 8. Docker 镜像构建

项目提供 `Dockerfile`：

```dockerfile
FROM oven/bun:alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY index.js ./
COPY src/ ./src/

EXPOSE 4097
ENV PORT=4097
ENV NODE_ENV=production

CMD ["bun", "run", "index.js"]
```

构建本地镜像：

```bash
docker build -t zqbxdev/opencodeapi:local .
```

本地运行：

```bash
docker run --rm -p 4097:4097 zqbxdev/opencodeapi:local
```

---

## 9. GitHub Actions 镜像发布链路

工作流文件：

```text
.github/workflows/docker-publish.yml
```

触发条件：

```yaml
on:
  push:
    tags:
      - '*'
```

也就是说：**只有推送 Git tag 时才会触发 Docker 镜像构建与推送**。

### 9.1 发布流程

```text
Developer pushes tag
  │
  ▼
GitHub Actions: Publish Docker Image
  │
  ├─ checkout code
  ├─ setup QEMU
  ├─ setup Docker Buildx
  ├─ docker/login-action login to Docker Hub
  ├─ docker/metadata-action generate image tags
  └─ docker/build-push-action build and push image
```

### 9.2 Docker Hub Secrets

该 workflow 使用 GitHub Repository Secrets 登录 Docker Hub：

```yaml
username: ${{ secrets.DOCKER_USERNAME }}
password: ${{ secrets.DOCKER_PASSWORD }}
```

必须在 GitHub 仓库中配置：

| Secret | 用途 |
|---|---|
| `DOCKER_USERNAME` | Docker Hub 用户名，例如 `zqbxdev` |
| `DOCKER_PASSWORD` | Docker Hub Access Token |

推荐使用 Docker Hub Access Token，而不是账户密码。

配置路径：

```text
GitHub Repository
→ Settings
→ Secrets and variables
→ Actions
→ Repository secrets
```

Docker Hub token 创建路径：

```text
Docker Hub
→ Account Settings
→ Security
→ New Access Token
```

### 9.3 生成的镜像标签

workflow 通过 `docker/metadata-action` 生成：

```yaml
tags: |
  type=ref,event=tag
  type=raw,value=latest
```

例如推送：

```text
v1.0.0
```

会生成并推送：

```text
zqbxdev/opencodeapi:v1.0.0
zqbxdev/opencodeapi:latest
```

### 9.4 重新触发失败的 tag 构建

如果第一次构建失败，例如 Docker Hub secrets 没有配置，可以删除并重新推送同一个 tag：

```bash
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0
git tag v1.0.0
git push origin v1.0.0
```

也可以直接发布新 tag：

```bash
git tag v1.0.1
git push origin v1.0.1
```

---

## 10. 运行时配置

当前服务主要通过环境变量控制端口：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4097` | HTTP 服务监听端口 |
| `NODE_ENV` | `production` in Docker | 运行环境标识 |

Docker 中默认设置：

```text
PORT=4097
NODE_ENV=production
```

---

## 11. 维护建议

1. **保持 workflow secrets 最小权限**：Docker Hub token 建议只用于当前镜像仓库的 Read/Write。
2. **发布版本使用语义化 tag**：例如 `v1.0.0`、`v1.0.1`。
3. **修改上游协议适配时必须跑压测**：至少运行 `bun run test-stress.js`。
4. **新增特殊模型时更新过滤与协议映射**：如果模型不是标准 Chat Completions 协议，需要在 `executor.js` 中加入转换逻辑。
5. **避免无意义高并发滥用上游公共通道**：服务适合自用与测试，不应用于批量刷量或商业转售。

---

## 12. 故障排查

### Docker workflow: Username and password required

说明 GitHub Secrets 未配置或名称不匹配。检查：

```text
DOCKER_USERNAME
DOCKER_PASSWORD
```

### Docker workflow: denied: requested access to the resource is denied

常见原因：

1. Docker Hub token 权限不足。
2. Docker Hub 仓库不存在或不属于该账号。
3. `images:` 配置与 Docker Hub namespace 不一致。

当前目标镜像：

```text
zqbxdev/opencodeapi
```

### Workflow 没有触发

确认推送的是 tag，而不是普通 commit：

```bash
git tag v1.0.1
git push origin v1.0.1
```

### SSE 请求很快结束

检查客户端是否支持 SSE，并确认请求体包含：

```json
"stream": true
```

### 模型不可用

先调用：

```bash
curl http://localhost:4097/v1/models
```

确认模型是否在当前动态列表或 fallback 列表中。
