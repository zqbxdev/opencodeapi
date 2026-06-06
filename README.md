# OpenCodeAPI - OpenCode 免费模型 OpenAI 兼容代理

`opencodeapi` 是一个轻量级 OpenAI-compatible API 代理服务，用于将 OpenCode 的免费模型接口包装成标准 `/v1/models` 与 `/v1/chat/completions` 形式。它支持流式 SSE 与非流式调用、动态模型发现、模型列表缓存、静态兜底，以及客户端断开后的上游请求中止释放。

GitHub 仓库：<https://github.com/zqbxdev/opencodeapi>
Docker Hub 镜像：<https://hub.docker.com/repository/docker/zqbxdev/opencodeapi>

## 核心特性

- **OpenAI 兼容接口**：提供 `GET /v1/models` 与 `POST /v1/chat/completions`。
- **支持流式与非流式**：兼容常见 OpenAI SDK、OpenWebUI、LobeChat、Cline 等客户端。
- **动态模型发现**：从 OpenCode 云端模型接口拉取模型，并过滤免费模型。
- **1 小时内存缓存**：减少模型列表请求开销，提升接口响应速度。
- **静态兜底模型列表**：当上游模型接口不可用时仍可返回可用模型列表。
- **协议适配**：对部分非 OpenAI Chat Completions 协议模型进行请求/响应格式转换。
- **Abort 级联中止**：客户端断开连接后主动中止上游 fetch，减少僵尸连接与带宽浪费。
- **Docker 部署**：提供轻量 `Dockerfile` 与 Docker Hub 镜像发布工作流。
- **Tag 触发发布**：推送 Git tag 后自动构建并推送 Docker 镜像到 Docker Hub。

## 快速开始

### 本地运行

```bash
bun install
bun run index.js
```

默认监听端口：

```text
4097
```

服务启动后，OpenAI-compatible Base URL 为：

```text
http://localhost:4097/v1
```

### Docker 运行

```bash
docker run -d \
  --name opencodeapi \
  --restart unless-stopped \
  -p 4097:4097 \
  zqbxdev/opencodeapi:latest
```

使用指定版本：

```bash
docker run -d \
  --name opencodeapi \
  --restart unless-stopped \
  -p 4097:4097 \
  zqbxdev/opencodeapi:v1.0.0
```

## API 使用示例

### 查询模型列表

```bash
curl http://localhost:4097/v1/models
```

返回格式兼容 OpenAI models API：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash-free",
      "object": "model",
      "created": 0,
      "owned_by": "opencode"
    }
  ]
}
```

### 流式聊天补全

```bash
curl -N http://localhost:4097/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [
      {"role": "user", "content": "用一个词向我问好"}
    ],
    "stream": true
  }'
```

### 非流式聊天补全

```bash
curl http://localhost:4097/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [
      {"role": "user", "content": "写一句简短介绍"}
    ],
    "stream": false
  }'
```

### 使用示例脚本

```bash
bun run example.js
```

### 压力测试

```bash
bun run test-stress.js
```

`test-stress.js` 会发起多个并发请求，并为每个请求设置超时，便于验证流式响应、非流式响应与连接中断处理。

## Docker 镜像发布

仓库内置 GitHub Actions 工作流：

```text
.github/workflows/docker-publish.yml
```

触发条件是推送任意 Git tag：

```yaml
on:
  push:
    tags:
      - '*'
```

触发后会构建镜像并推送到：

```text
zqbxdev/opencodeapi
```

发布出的 tag 包括：

```text
zqbxdev/opencodeapi:<git-tag>
zqbxdev/opencodeapi:latest
```

例如推送 `v1.0.0` 后会发布：

```text
zqbxdev/opencodeapi:v1.0.0
zqbxdev/opencodeapi:latest
```

### GitHub Secrets 配置

首次使用前，需要在 GitHub 仓库中配置 Docker Hub 凭据：

```text
Repository Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

需要添加两个 Repository Secrets：

| Secret 名称 | 说明 |
|---|---|
| `DOCKER_USERNAME` | Docker Hub 用户名，例如 `zqbxdev` |
| `DOCKER_PASSWORD` | Docker Hub Access Token，推荐不要使用账户密码 |

Docker Hub Access Token 创建路径：

```text
Docker Hub
→ Account Settings
→ Security
→ New Access Token
```

建议至少授予镜像仓库的 Read/Write 权限。

### 发布新版本

```bash
git tag v1.0.1
git push origin v1.0.1
```

### 重新触发已有版本构建

如果某个 tag 的 workflow 因 Docker Hub secrets 缺失而失败，可以删除远程 tag 后重新推送：

```bash
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0
git tag v1.0.0
git push origin v1.0.0
```

## 常见问题

### 1. Docker workflow 登录失败

通常是 GitHub Secrets 未配置或名称不正确。确认仓库中存在：

```text
DOCKER_USERNAME
DOCKER_PASSWORD
```

其中 `DOCKER_PASSWORD` 推荐填写 Docker Hub Access Token。

### 2. Docker Hub 仓库不存在

部分 Docker Hub 账号配置允许首次 push 自动创建仓库，部分情况下需要先手动创建：

```text
https://hub.docker.com/repository/docker/zqbxdev/opencodeapi
```

### 3. 客户端连接后没有持续输出

确认请求中设置了：

```json
"stream": true
```

同时客户端需要支持 SSE，例如使用 `curl -N`。

### 4. 模型列表为空或请求失败

服务会优先从 OpenCode 云端动态拉取模型；如果上游短暂不可用，会自动降级到静态兜底列表。可以稍后重试或检查服务端日志。

## 技术文档

详细架构说明见：

```text
TECHNICAL.md
```

## 免责声明

本项目仅用于技术研究、兼容性测试与自托管代理实验。请遵守上游服务条款、合理使用公共服务资源，不要进行滥用、高频刷量或商业化转售。

## 开源协议

MIT
