# AuthRouter

一个面向个人与小型团队的自托管 SSO 中间件。它连接多个上游 OIDC / OAuth2 身份提供商，并向下游Wiki、博客等应用提供统一的 OpenID Connect 登录入口。

**原生支持 SQLite 与 MySQL 两种数据库后端，可在部署时按场景选择，无需修改代码。**

> 项目目前适合单实例部署。管理员会话和部分 OIDC 临时状态保存在进程内存中，暂不支持无状态多副本或高可用集群。

**进阶文档：** [上游 / 下游配置指南](docs/upstream-downstream-config.md)，包含 Issuer、回调地址、OIDC/OAuth2 字段以及常见配置误区。

## 它解决什么问题

当多个应用需要统一登录，但它们支持的身份源、账号字段或 OIDC 配置方式不一致时，本项目可以作为中间层：

```text
上游 IdP（Google / GitHub / Keycloak / Azure AD 等）
                    | OIDC / OAuth2
                    v
                  AuthRouter
                    | OpenID Connect
                    v
下游应用（Mailcow / Wiki / Blog / 自建服务等）
```

- 面向上游时，它是 OIDC / OAuth2 Client。
- 面向下游时，它是标准 OIDC Provider。
- 上游身份可以原样传递，也可以按下游客户端映射为其他账号。

## 主要能力

- 支持多个标准 OIDC 上游，通过 Issuer 自动发现端点
- 支持多个通用 OAuth2 上游，可手动配置授权、令牌和用户信息端点
- 通过管理面板动态管理上游 IdP、下游客户端和身份映射
- 配置变更即时生效，无需修改代码或重启服务
- 每个下游客户端独立生成 Client ID 与 Client Secret
- 支持 SQLite（默认）和 MySQL
- 使用 AES-256-GCM 加密存储上下游 Client Secret
- 自动生成并持久化 JWKS、加密密钥和 Session 签名密钥
- 单上游自动跳转，多上游展示登录方式选择页

## SQLite 与 MySQL

项目对 SQLite 和 MySQL 使用同一套数据访问接口与业务逻辑。通过 `DB_DRIVER` 选择数据库，应用首次启动时会自动创建所需的数据表。

| 数据库 | 适合场景 | 部署要求 | 数据位置 |
| --- | --- | --- | --- |
| SQLite（默认） | 个人部署、单机服务、快速体验 | 无需额外数据库服务 | `${DATA_DIR}/sso.db` |
| MySQL | 已有 MySQL 基础设施、希望独立管理数据库与备份 | 可访问的 MySQL 实例，并预先创建数据库和账号 | 外部 MySQL 实例 |

两种数据库都完整支持上游 IdP、下游客户端和身份映射管理。无论选择哪一种，`DATA_DIR` 仍需持久化，因为 JWKS、加密密钥和 Session 密钥保存在其中。

> `DB_DRIVER` 只负责选择后端，不会在 SQLite 与 MySQL 之间迁移已有数据。已有部署切换数据库前，需要自行完成数据迁移并同时备份 `DATA_DIR`。

## 快速部署

### 前置条件

- Docker Engine
- Docker Compose v2
- 一个已解析到服务器的域名
- 能为该域名提供 HTTPS 的反向代理，例如 Nginx、Caddy 或 Traefik

公网部署必须使用 HTTPS，并显式设置正确的 `SSO_BASE_URL`。OIDC Issuer、回调地址和 Cookie 都依赖这个地址。

### 1. 创建配置

在项目目录执行：

```bash
cp .env.example .env
```

至少修改以下两项：

```dotenv
SSO_BASE_URL=https://sso.example.com
ADMIN_PASSWORD=replace-with-a-long-random-password
```

`SSO_BASE_URL` 不要以 `/` 结尾。未设置 `ADMIN_PASSWORD` 时，服务会生成随机密码并输出到容器日志；生产环境建议显式设置。

数据库默认为 SQLite，不需要额外配置。如需使用 MySQL，在 `.env` 中增加：

```dotenv
DB_DRIVER=mysql
MYSQL_HOST=mysql.example.internal
MYSQL_PORT=3306
MYSQL_USER=sso
MYSQL_PASSWORD=replace-with-a-database-password
MYSQL_DATABASE=sso
```

MySQL 数据库和账号需要提前创建，并允许应用账号连接及创建数据表。容器内的 `localhost` 指向 SSO 容器自身；MySQL 运行在其他主机或容器时，`MYSQL_HOST` 必须填写该服务可被 SSO 容器访问的主机名。

### 2. 构建并启动

```bash
docker compose up -d --build
docker compose logs -f authrouter
```

默认只监听宿主机的 `127.0.0.1:3000`，不会直接暴露到公网。外部流量应由 HTTPS 反向代理转发。

如果使用自动生成的管理员密码，可在启动日志中找到它：

```bash
docker compose logs authrouter
```

### 3. 配置 HTTPS 反向代理

仓库中的 [`nginx.conf`](nginx.conf) 提供了完整示例。核心配置如下：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
}
```

反向代理使用的域名必须与 `.env` 中的 `SSO_BASE_URL` 完全一致，包括协议和端口。

### 4. 验证服务

```bash
curl https://sso.example.com/health
curl https://sso.example.com/.well-known/openid-configuration
```

`/health` 应返回 `status: ok`，Discovery 文档中的 `issuer` 应与 `SSO_BASE_URL` 完全一致。

### 5. 完成首次配置

1. 打开 `https://sso.example.com/admin` 并登录。
2. 添加至少一个上游 OIDC 或 OAuth2 身份提供商。
3. 在上游平台登记回调地址：`https://sso.example.com/sso/{provider_id}/callback`。
4. 在管理面板创建下游 OIDC 客户端，并立即保存只展示一次的 Client Secret。
5. 将 Discovery URL、Client ID 和 Client Secret 填入下游应用。
6. 从下游应用发起一次完整登录测试。

上游与下游的 Issuer、回调地址和端点很容易混淆。完整字段说明及 Google、GitHub、Keycloak 示例见[上游 / 下游配置指南](docs/upstream-downstream-config.md)。

## 配置上游与下游

### 上游 OIDC

适用于 Google、Keycloak、Azure AD、Authentik 等支持 OpenID Connect Discovery 的服务。

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 标识 | `google` | 唯一且适合放入 URL，决定回调路径 |
| 名称 | `Google` | 登录页显示名称 |
| 类型 | `oidc` | 使用 OIDC 自动发现 |
| Issuer | `https://accounts.google.com` | 上游服务自己的 Issuer |
| Client ID / Secret | 上游平台签发 | 在上游平台创建 OAuth Client 后获得 |
| Scope | `openid email profile` | 通常保留默认值 |

对应的上游回调地址为：

```text
https://sso.example.com/sso/google/callback
```

### 上游 OAuth2

适用于 GitHub 等不提供标准 OIDC Discovery 的服务。除 Client ID 和 Secret 外，还需要配置 Authorize URL、Token URL、Userinfo URL，以及上游 JSON 响应的字段映射。

### 下游 OIDC 客户端

所有下游应用共用同一组 OIDC 端点，通过各自的 Client ID、Client Secret 和回调地址区分：

| 配置项 | 值 |
| --- | --- |
| Issuer | `https://sso.example.com` |
| Discovery | `https://sso.example.com/.well-known/openid-configuration` |
| Authorization Endpoint | `https://sso.example.com/auth` |
| Token Endpoint | `https://sso.example.com/token` |
| UserInfo Endpoint | `https://sso.example.com/me` |
| JWKS URI | `https://sso.example.com/jwks` |
| Scopes | `openid email profile` |

优先使用 Discovery URL 自动配置。若下游 Token 交换提示客户端认证失败，可在管理面板中切换 `client_secret_post` 与 `client_secret_basic`。

### 身份映射

身份映射按“下游客户端 + 上游提供商 + 上游身份”生效：

| 匹配的映射数量 | 登录行为 |
| --- | --- |
| 0 | 直接使用上游返回的身份 |
| 1 | 自动使用映射后的身份 |
| 多条 | 展示账号选择页 |

例如，可以让 `yourname@gmail.com` 登录 Mailcow 后映射为 `postmaster@example.com`，同时在其他下游应用中继续使用原始 Gmail 身份。

## 环境变量

所有变量及注释也可在 [`.env.example`](.env.example) 中查看。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SSO_BASE_URL` | `http://localhost:3000` | 对外访问地址及 OIDC Issuer；公网部署必须设置 |
| `SSO_PORT` | `3000` | 应用监听端口 |
| `DB_DRIVER` | `sqlite` | 数据库驱动：`sqlite` 或 `mysql` |
| `ADMIN_USERNAME` | `admin` | 管理面板用户名 |
| `ADMIN_PASSWORD` | 自动生成 | 管理面板密码 |
| `DATA_DIR` | `/app/data` | SQLite、JWKS 和自动生成密钥的持久化目录 |
| `ENCRYPTION_KEY` | 自动生成并持久化 | 32 字节 hex 或 base64 密钥，用于加密 Client Secret |
| `SESSION_SECRET` | 自动生成并持久化 | Session Cookie 签名密钥 |
| `MYSQL_HOST` | `localhost` | MySQL 地址，仅 `DB_DRIVER=mysql` 时使用 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | 无 | MySQL 用户名，使用 MySQL 时必填 |
| `MYSQL_PASSWORD` | 无 | MySQL 密码 |
| `MYSQL_DATABASE` | 无 | MySQL 数据库名，使用 MySQL 时必填 |

使用 MySQL 时，Compose 文件不会自动创建数据库，需要连接到已存在的 MySQL 实例。应用会自动创建业务表，但不会创建 MySQL Database 或用户。

## 生产部署检查

公开到公网前，至少确认以下事项：

- `SSO_BASE_URL` 使用 HTTPS，且没有结尾斜杠
- `ADMIN_PASSWORD` 已设置为独立的强密码
- 应用端口只监听回环地址或内网地址
- `/app/data` 对应的 Docker Volume 已持久化并纳入备份
- 若使用 MySQL，数据库与 `DATA_DIR` 中的密钥文件一起备份
- 反向代理正确传递 `Host` 和 `X-Forwarded-*` 请求头
- 在反向代理层为 `/admin` 配置请求限流，或按部署条件限制来源地址
- 上游回调地址与下游 Redirect URI 均逐字符匹配
- 管理面板不经过 CDN 缓存，且已限制日志和备份文件的访问权限
- 升级前已备份数据，并在测试环境验证完整登录流程

`DATA_DIR` 中的 `jwks.json`、`encryption.key` 和 `session.key` 与数据库同等重要。丢失 `encryption.key` 将无法解密已保存的 Client Secret；替换 `jwks.json` 会使旧令牌的签名密钥失效。

### 当前限制

- 仅推荐单实例运行；进程内 Session Store 不支持多副本共享
- 重启会中断正在进行中的授权流程
- 不提供管理面板的多因素认证、细粒度权限或审计日志
- 不内置 TLS 终止，必须配合反向代理
- 不负责自动备份或密钥轮换

这些限制使它更适合个人服务、小团队和可信网络边界内的自托管场景，而不是企业级身份基础设施。

## 常见问题

### 上游提示 `redirect_uri_mismatch`

确认上游平台登记的地址与 `{SSO_BASE_URL}/sso/{provider_id}/callback` 完全一致，重点检查协议、域名、端口、标识和结尾斜杠。

### 下游提示 Issuer 不匹配

确认下游配置的 Issuer、Discovery 文档中的 `issuer` 和 `SSO_BASE_URL` 三者逐字符一致。

### 登录后跳转到 404

确认管理面板登记的下游回调地址与下游应用实际发送的 `redirect_uri` 完全一致。

### 管理登录密码在哪里

若未设置 `ADMIN_PASSWORD`，运行 `docker compose logs authrouter` 查看首次启动时生成的密码。修改 `.env` 后，运行 `docker compose up -d --force-recreate` 重建容器，使新的环境变量生效。

### 重启后出现 403 或授权失败

确认 Compose 的 `sso-data` Volume 仍正确挂载。已有登录 Cookie 依赖持久化的 `session.key`；正在进行中的授权流程在重启后需要重新发起。

## 开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

默认服务地址为 `http://localhost:3000`，管理面板为 `http://localhost:3000/admin`。

常用命令：

```bash
npm start
npm run dev
node --check src/index.js
```

### 技术栈

| 领域 | 实现 |
| --- | --- |
| Runtime / Web | Node.js 20、Koa、EJS |
| OIDC Provider | `oidc-provider` |
| OIDC Client | `openid-client` |
| 数据库 | `better-sqlite3`、`mysql2` |
| 密钥与加密 | `jose`、Node.js `crypto` |

### 项目结构

```text
src/
|-- index.js                  # 应用入口、路由与 OIDC 交互流程
|-- provider.js               # 下游 OIDC Provider 配置
|-- oidc-auth.js              # 上游 OIDC 适配器
|-- oauth2-auth.js            # 上游 OAuth2 适配器
|-- upstream-providers-db.js  # 上游配置持久化
|-- clients.js                # 下游客户端管理
|-- mapping.js                # 身份映射
|-- keys.js                   # JWKS 生成与持久化
|-- crypto-util.js            # Client Secret 加解密
|-- db/                       # SQLite / MySQL 驱动与表结构
`-- views/                    # 管理与登录页面
```

## 健康检查与标准端点

| 路径 | 用途 |
| --- | --- |
| `/health` | 服务状态与已启用的上游列表 |
| `/.well-known/openid-configuration` | OIDC Discovery |
| `/auth` | Authorization Endpoint |
| `/token` | Token Endpoint |
| `/me` | UserInfo Endpoint |
| `/jwks` | JSON Web Key Set |
| `/admin` | 管理面板 |

管理接口属于内部实现，不承诺跨版本稳定。自动化集成应优先依赖标准 OIDC 端点。

## 文档结构

- 本 README：项目介绍、SQLite / MySQL 部署、生产检查、开发与贡献入口
- [上游 / 下游配置指南](docs/upstream-downstream-config.md)：Issuer、回调地址、OIDC/OAuth2 字段和常见配置误区

`docs` 目录用于容纳需要独立查阅的专题指南，避免 README 再次膨胀。部署方式和环境变量以 README 与 `.env.example` 为准。

## 贡献

欢迎通过 Issue 报告缺陷、提出兼容性需求，或提交 Pull Request。提交前请：

1. 说明使用的上游 IdP、下游应用、数据库类型和部署方式。
2. 对行为变更补充可复现步骤或测试方法。
3. 不要提交 `.env`、数据库、Client Secret、令牌或持久化密钥。
4. 保持改动聚焦，并同步更新受影响的文档。

安全问题请不要在公开 Issue 中附带真实凭据、令牌、邮箱或回调参数。先移除敏感信息，再提供最小复现。

## License

本项目基于 [MIT License](LICENSE) 开源。
