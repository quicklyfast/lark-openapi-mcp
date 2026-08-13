# 服务端多租户代理（Server Proxy）

本文档介绍如何将 lark-mcp 作为**服务端版 MCP** 部署，由多个 MCP 客户端（Claude / Cursor / Trae 等）通过 HTTP 携带各自的应用凭证连接，实现多租户共用一套 MCP 服务。

## 目录

- [什么是服务端代理](#什么是服务端代理)
- [快速开始](#快速开始)
- [客户端配置](#客户端配置)
- [凭证头说明](#凭证头说明)
- [App ID 白名单](#app-id-白名单)
- [环境变量](#环境变量)
- [安全建议](#安全建议)
- [常见问题](#常见问题)

## 什么是服务端代理

本地模式（stdio）下，凭证固定在 MCP 启动命令里，每个客户端各自启动一个进程。服务端代理模式下：

- MCP 服务**集中部署**在服务器上，一个进程服务所有客户端；
- 客户端连接时通过 HTTP header 携带自己的凭证（App ID / App Secret / 用户令牌）；
- 每个 MCP 会话**独立绑定**一份凭证，互不干扰。

```
MCP 客户端 A ── header: X-App-Id=cli_aaa ─┐
MCP 客户端 B ── header: X-App-Id=cli_bbb ─┼──►  lark-mcp 服务端 ──► 飞书/Lark OpenAPI
MCP 客户端 C ── header: X-App-Id=cli_ccc ─┘         (会话隔离)
```

## 快速开始

### 第 1 步：在服务器启动 HTTP 服务

```bash
npx -y @larksuiteoapi/lark-mcp mcp \
  -m streamable \
  --host 0.0.0.0 \
  -p 3000
```

> 💡 服务端代理模式**不需要**在启动命令里指定 `-a` / `-s`，凭证由客户端在连接时提供。启动后持续监听 `http://<host>:<port>/mcp`。

### 第 2 步：在 MCP 客户端配置 URL 与 header

```json
{
  "mcpServers": {
    "lark-mcp": {
      "url": "https://your-server:3000/mcp",
      "headers": {
        "X-App-Id": "cli_xxxx",
        "X-App-Secret": "your_app_secret",
        "X-User-Access-Token": "u-xxxx"
      }
    }
  }
}
```

## 客户端配置

不同客户端配置自定义 header 的方式如下：

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "lark-mcp": {
      "url": "https://your-server/mcp",
      "headers": {
        "X-App-Id": "cli_xxxx",
        "X-App-Secret": "your_app_secret"
      }
    }
  }
}
```

### Cursor / Trae

在 MCP 配置中新增 `headers` 字段即可（`url` 类型的 server 均支持自定义 header）：

```json
{
  "mcpServers": {
    "lark-mcp": {
      "url": "http://your-server:3000/mcp",
      "headers": {
        "X-App-Id": "cli_xxxx",
        "X-App-Secret": "your_app_secret",
        "X-User-Access-Token": "u-xxxx"
      }
    }
  }
}
```

## 凭证头说明

| Header | 必填 | 说明 |
|--------|------|------|
| `X-App-Id` | 是 | 飞书/Lark 应用 App ID，形如 `cli_xxxx` |
| `X-App-Secret` | 是 | 飞书/Lark 应用 App Secret |
| `X-User-Access-Token` | 否 | 用户访问令牌，形如 `u-xxxx`；提供后将以用户身份调用 API |
| `X-Domain` | 否 | 飞书/Lark 域名，默认为 `https://open.feishu.cn`；Lark 国际版填 `https://open.larksuite.com` |

### 应用身份 vs 用户身份

- **只带 `X-App-Id` + `X-App-Secret`**：以**应用身份**（tenant_access_token）调用，适合读组织公共数据等场景。
- **额外带 `X-User-Access-Token`**：以**用户身份**调用，可访问用户私有数据（个人文档、日历、IM 消息等）。

> ⚠️ 一旦提供 `X-User-Access-Token`，服务会自动强制使用 `user_access_token` 模式，避免回落到应用身份导致权限不足。

### 用户令牌如何获取

用户访问令牌可通过 OAuth 授权获取，常见方式：

1. 使用飞书开放平台 OAuth 授权流程获取 `user_access_token`；
2. 也可参考本地登录流程（`lark-mcp login`）理解授权过程，但服务端代理模式下令牌由客户端自行管理与携带。

## App ID 白名单

生产环境建议开启白名单，只允许指定的 App ID 连接：

```bash
npx -y @larksuiteoapi/lark-mcp mcp \
  -m streamable \
  --host 0.0.0.0 \
  -p 3000 \
  --allow-app-ids cli_aaa,cli_bbb
```

不在白名单内的 App ID 请求会返回 `401` 拒绝。也可通过环境变量配置：

```bash
export LARK_ALLOW_APP_IDS=cli_aaa,cli_bbb
```

## 环境变量

| 环境变量 | 说明 | 示例 |
|----------|------|------|
| `LARK_ALLOW_APP_IDS` | App ID 白名单，逗号或空格分隔，留空则不限制 | `cli_aaa,cli_bbb` |
| `LARK_DOMAIN` | 默认 API 域名（可被 `X-Domain` 头覆盖） | `https://open.feishu.cn` |
| `LARK_TOOLS` | 默认启用的工具列表 | `preset.default` |
| `LARK_TOKEN_MODE` | 默认令牌模式 | `auto` |

> 💡 `--host`、`--port`、`--mode` 等参数需通过命令行指定，不支持环境变量。

## 安全建议

- **必须使用 HTTPS**：header 中包含 App Secret 与用户令牌，明文 HTTP 会泄露凭证，生产环境务必配置 TLS 反向代理（如 Nginx / Caddy）。
- **开启 App ID 白名单**：通过 `--allow-app-ids` 限制可连接的租户。
- **令牌轮换**：`user_access_token` 有有效期，过期后工具调用会返回飞书错误码，客户端需自行换取新令牌后重连。
- **反向代理加固**：可将 `/mcp` 端点置于鉴权网关之后，限制来源 IP。

## 常见问题

**Q1：为什么返回 `401 Missing X-App-Id / X-App-Secret headers`？**
连接请求未携带 `X-App-Id` 和 `X-App-Secret` header，请检查客户端配置中的 `headers` 字段。

**Q2：Lark 国际版怎么连？**
在客户端 `headers` 中增加 `"X-Domain": "https://open.larksuite.com"`。注意：国际版应用不能使用飞书中国版，反之亦然。

**Q3：用户令牌过期了怎么办？**
服务端代理模式不托管令牌刷新，客户端需重新获取 `user_access_token` 后重连（断开并重建 MCP 会话）。

**Q4：多个客户端可以共用同一个 App ID 吗？**
可以，每个会话独立绑定一份 client 实例，互不影响。但建议为不同用户分配独立 App ID 以便审计与限流。

**Q5：会话多久不活动会被回收？**
服务端会回收超过 30 分钟无活动的会话，客户端下次请求会自动建立新会话。

## Docker 部署

项目提供了服务端代理专用的轻量镜像与 Compose 编排文件。

### 构建镜像

先在本地编译产物，再构建镜像（生产依赖会在镜像内安装）：

```bash
yarn build
docker build -f Dockerfile.server -t lark-mcp-server:latest .
```

### 使用 Compose 一键部署

1. 复制环境变量模板并按需修改：

```bash
cp .env.example .env
# 编辑 .env，配置 LARK_ALLOW_APP_IDS 白名单等
```

2. 启动服务：

```bash
docker compose up -d --build
```

3. 查看日志与状态：

```bash
docker compose logs -f lark-mcp
docker compose ps
```

### 客户端连接

服务默认暴露在 `http://<host>:3000/mcp`（端口可由 `LARK_MCP_PORT` 调整），客户端配置同前文，仅将 `url` 指向该地址并携带凭证 header 即可。

> 💡 **生产建议**：Compose 暴露的是明文 HTTP，生产环境请在前面加一层 HTTPS 反向代理（Nginx / Caddy），或在容器编排平台挂载 TLS 证书，避免 header 中的 App Secret 与用户令牌泄露。

## 相关文档

- [配置指南](configuration-zh.md)
- [命令行参考](../../reference/cli/cli-zh.md)
- [Docker 使用指南](../docker/docker-zh.md)
- [主要文档](../../../README_ZH.md)
