# OpenCodeAPI - OpenCode 免费大模型代理服务

`opencodeapi` 是一个高性能、生产级、开箱即用的 OpenAI 兼容接口代理服务。它能完全复刻并代理 OpenCode 的所有免费/隐身测试模型接口（如 `deepseek-v4-flash-free`，`big-pickle`，`mimo-v2.5-free` 等），且支持流式（SSE）与非流式调用，无需配置任何 API Key 或安装 OpenCode 本地客户端。

## 🌟 核心特性

- **完全零配置**：无需配置 API Key，利用官方公用 Bearer Token 与设备 Header 伪装直接访问。
- **云端动态拉取**：模型列表动态获取并自动过滤出所有免费模型，在官方上线新免费模型时无需重启服务。
- **1 小时高性能缓存 (TTL)**：自动在内存中缓存模型列表，避免每次请求都进行额外的云端握手。
- **降级兜底保障 (Static Fallback)**：当官方模型接口发生网络故障或 DNS 异常时，自动降级至本地静态列表，确保高可用。
- **生产级中断回收 (Abort Controller)**：采用响应流 `close` 监听，在客户端中断请求（如中途取消或关闭窗口）时立即调用 Abort 释放云端连接与带宽，绝不浪费网络资源。
- **协议双向适配**：支持针对特定非标协议模型（如 `big-pickle` 使用的 Anthropic 消息格式）自动双向转换，让其可以使用标准的 OpenAI 协议请求。
- **极简超小容器**：基于 `oven/bun:alpine` 镜像打包，内存占用极小。

## 🚀 快速开始

### 使用 Bun/Node 本地运行

```bash
# 安装依赖
bun install

# 运行服务 (默认监听 4097 端口)
bun run index.js
```

### 使用 Docker 部署

```bash
docker run -d \
  -p 4097:4097 \
  --name opencodeapi \
  --restart unless-stopped \
  zqbxdev/opencodeapi:latest
```

## 💬 接口使用示例

支持所有的 OpenAI 兼容客户端（如 LobeChat、OpenWebUI、Cline 等），将 Base URL 设定为 `http://localhost:4097/v1` 即可。

### 1. 查询可用模型列表

```bash
curl http://localhost:4097/v1/models
```

### 2. 对话补全接口（流式 SSE）

```bash
curl -N http://localhost:4097/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "用一个词向我问好"}],
    "stream": true
  }'
```

### 3. 测试用例运行

我们在根目录下提供了一个测试脚本，用于快速测试 SSE 流式输出效果：

```bash
bun run example.js
```

## 🛠 压测与性能

本项目内置并发与压力测试脚本 `test-stress.js`。您可以通过运行以下命令，模拟多个并发请求（混合流式与非流式、不同模型）并附带 10 秒超时检测：

```bash
bun run test-stress.js
```

---

## 📄 开源协议

本项目基于 MIT 协议开源。
