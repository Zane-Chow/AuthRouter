# Personal SSO Middleware

通用的个人 OIDC 代理中间件 — 支持多个上游身份提供商（Google、GitHub、Keycloak、Azure AD 等任意 OIDC/OAuth2 提供者）和多个下游网站接入，**全部通过管理面板配置，无需改代码或重启服务**。

## 架构

```
上游 IdP (Google / GitHub / Keycloak / ...)
         ↕ OAuth2 / OIDC
   ┌─────────────────────┐
   │   SSO 中间件         │   ← 你在这里
   │  (oidc-provider)     │
   └─────────────────────┘
         ↕ OIDC
下游 RP (Mailcow / Wiki / Blog / ...)
```

- **对上游 IdP**：中间件是一个 OAuth2 / OIDC 客户端
- **对下游 RP**：中间件是一个标准 OIDC 身份提供者
- **核心功能**：统一身份认证入口，可将上游身份映射为下游系统所需的任意身份

### 特性

- ✅ 多上游 IdP：标准 OIDC（自动发现，如 Google、Keycloak、Azure AD）+ 通用 OAuth2（手动配置端点，如 GitHub），全部通过管理面板添加
- ✅ 多下游 RP：通过管理面板动态注册 OIDC 客户端，Client ID / Secret 由服务器自动生成
- ✅ 全热更新：新增/修改/删除上游 IdP 或下游客户端**立即生效**，无需重启服务
- ✅ 灵活的身份映射：每个客户端独立配置映射关系
- ✅ 智能映射策略：0 映射直通原始身份 / 1 映射自动使用 / 多映射展示选择器
- ✅ 管理面板：上游 IdP 管理 + 客户端管理 + 映射管理，一站式配置
- ✅ Docker Compose 一键部署
- ✅ 自动生成和持久化 JWKS 签名密钥（RSA256）
- ✅ 存储层可选 SQLite（默认，单文件零配置）或 MySQL，部署时通过 `DB_DRIVER` 选择
- ✅ 客户端密钥、上游 IdP 密钥均加密存储（AES-256-GCM），支持自定义或自动生成加密密钥
- ✅ 单 IdP 自动跳转，多 IdP 展示选择器

---

## 快速部署

### 1. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，按需修改以下选项（**所有选项均为可选**，不配置也可直接启动）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SSO_BASE_URL` | SSO 中间件的外部访问地址（建议 HTTPS） | `http://localhost:3000` |
| `SSO_PORT` | 内部监听端口（反向代理后端） | `3000` |
| `DB_DRIVER` | 数据库类型：`sqlite` 或 `mysql` | `sqlite` |
| `ADMIN_USERNAME` | 管理面板用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理面板密码（不设置则自动生成随机强密码，打印在 Docker 日志中） | 随机生成 |
| `ENCRYPTION_KEY` | 密钥加密密钥（可选，留空则首次运行自动生成） | 自动生成 |
| `DATA_DIR` | 数据持久化目录（SQLite 数据库、JWKS 密钥等） | `/app/data` |

> **注意**：`SESSION_SECRET` 已取消，启动时自动生成，无需用户配置。

> **注意**：上游 IdP（如 Google、GitHub）不再通过 `.env` 配置，全部通过 `/admin` 管理面板添加和管理。

使用 MySQL 时，还需配置：

| 变量 | 说明 |
|------|------|
| `MYSQL_HOST` | MySQL 主机 |
| `MYSQL_PORT` | MySQL 端口 |
| `MYSQL_USER` | MySQL 用户名 |
| `MYSQL_PASSWORD` | MySQL 密码 |
| `MYSQL_DATABASE` | MySQL 数据库名 |

### 2. 配置 Nginx 反向代理

项目提供了示例 `nginx.conf`，可直接参考：

```nginx
server {
    listen 80;
    server_name sso.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name sso.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

### 3. 启动 SSO 中间件

```bash
docker compose up -d
```

验证服务是否正常：

```bash
# 检查日志
docker compose logs -f

# 验证 OIDC Discovery
curl https://sso.example.com/.well-known/openid-configuration
```

### 4. 添加上游身份提供商

1. 打开管理面板：`https://sso.example.com/admin`
2. 使用 `.env` 中配置的管理员账号登录
3. 在 **上游身份提供商** 区域添加 IdP

#### 添加 OIDC 类型的 IdP（如 Google）

在上游 IdP 的开发者平台创建 OAuth 客户端后，在管理面板中填入：

| 字段 | 示例值 | 说明 |
|------|--------|------|
| 标识 | `google` | URL 友好的唯一标识 |
| 名称 | `Google` | 登录页显示名 |
| 类型 | `oidc` | 标准 OIDC，自动发现端点 |
| Issuer | `https://accounts.google.com` | OIDC Issuer URL |
| Client ID | *(从 Google Cloud Console 获取)* | |
| Client Secret | *(从 Google Cloud Console 获取)* | |
| 回调地址 | — | 自动生成：`{SSO_BASE_URL}/sso/google/callback` |

> 在 Google Cloud Console 中，需将 `https://sso.example.com/sso/google/callback` 添加为**已授权的重定向 URI**。

#### 添加 OAuth2 类型的 IdP（如 GitHub）

对于非标准 OIDC 的 OAuth2 提供者，需手动配置端点和字段映射：

| 字段 | 示例值 |
|------|--------|
| 标识 | `github` |
| 名称 | `GitHub` |
| 类型 | `oauth2` |
| Authorize URL | `https://github.com/login/oauth/authorize` |
| Token URL | `https://github.com/login/oauth/access_token` |
| Userinfo URL | `https://api.github.com/user` |
| Email URL（可选） | `https://api.github.com/user/emails` |
| Scope | `user:email` |
| 字段映射 | `id` → `id`, `email` → `email`, `name` → `login`, `avatar` → `avatar_url` |

> 在 GitHub Developer Settings 中，需将 `https://sso.example.com/sso/github/callback` 设置为 **Authorization callback URL**。

### 5. 注册下游客户端

在管理面板的 **OIDC 客户端** 区域添加客户端：

| 字段 | 示例值 | 说明 |
|------|--------|------|
| 名称 | `Mailcow 邮件` | 客户端显示名 |
| 回调地址 | `https://mail.example.com/...` | 下游系统的 OAuth 回调地址 |
| 认证方式 | `client_secret_post` | 或 `client_secret_basic` |
| Scope | `openid email profile` | 授权范围 |

> **Client ID 和 Client Secret 由服务器自动生成**，创建成功后仅显示一次，请妥善保存。添加后**立即生效**，无需重启服务。

### 6. 配置下游系统

以 Mailcow 为例，在其管理面板配置 OIDC 集成：

| 设置 | 值 |
|------|------|
| Authorization Endpoint | `https://sso.example.com/auth` |
| Token Endpoint | `https://sso.example.com/token` |
| User Info Endpoint | `https://sso.example.com/me` |
| Client ID | 与管理面板中生成的 Client ID 一致 |
| Client Secret | 与管理面板中生成的 Client Secret 一致 |
| Scopes | `openid email profile` |

也可以直接使用 OIDC Discovery URL 进行自动配置：

```
https://sso.example.com/.well-known/openid-configuration
```

### 7. 添加身份映射（可选）

默认情况下，中间件会**直通**上游 IdP 返回的原始身份（如 Gmail 邮箱），无需配置映射。

如果下游系统需要不同的身份（例如用 Gmail 登录但使用自定义域名邮箱），可以在管理面板添加映射：

| 字段 | 示例值 |
|------|--------|
| 客户端 | `Mailcow 邮件 (client-id)` |
| 登录平台 | `google` |
| 来源身份 | `yourname@gmail.com` |
| 目标身份 | `postmaster@example.com` |

**映射策略：**

| 映射数量 | 行为 |
|----------|------|
| 0 条 | 直通上游身份（默认） |
| 1 条 | 自动使用映射后的身份 |
| 多条 | 弹出选择器让用户选择 |

### 8. 测试登录

1. 打开下游系统登录页面（如 Mailcow）
2. 点击 SSO 登录按钮
3. 选择登录方式（仅配了一个 IdP 时自动跳转）
4. 完成上游认证后自动返回下游系统

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（文件变更自动重启）
npm run dev
```

### 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js 20+ (ESM) |
| Web 框架 | Koa |
| OIDC Provider | oidc-provider |
| OIDC Client | openid-client |
| 模板引擎 | EJS |
| 数据库 | better-sqlite3 / mysql2 |
| 加密 | jose (JWKS), Node.js crypto (AES-256-GCM) |

### 项目结构

```
src/
├── index.js                 # 主入口：路由、OIDC 交互、管理面板
├── config.js                # 环境变量配置
├── provider.js              # oidc-provider 实例创建
├── oidc-adapter.js          # 自定义 oidc-provider Adapter（Client 热加载）
├── upstream-providers.js    # 上游 IdP 统一调度层
├── upstream-providers-db.js # 上游 IdP 数据库 CRUD
├── oidc-auth.js             # OIDC 类型上游适配器
├── oauth2-auth.js           # OAuth2 类型上游适配器
├── clients.js               # 下游客户端管理
├── mapping.js               # 身份映射管理
├── keys.js                  # JWKS 密钥生成与持久化
├── crypto-util.js           # AES-256-GCM 加密工具
├── database.js              # 数据库入口
├── render.js                # EJS 模板渲染
├── db/
│   ├── index.js             # 数据库驱动初始化
│   ├── schema.js            # 表结构定义（SQLite + MySQL）
│   ├── sqlite-driver.js     # SQLite 驱动
│   └── mysql-driver.js      # MySQL 驱动
└── views/
    ├── admin.ejs             # 管理面板
    ├── login-selector.ejs    # 多 IdP 登录选择器
    ├── select-account.ejs    # 多映射身份选择器
    ├── login.ejs             # 登录页
    └── error.ejs             # 错误页
```

---

## API 端点

### OIDC 标准端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/openid-configuration` | GET | OIDC Discovery 文档 |
| `/auth` | GET | OIDC 授权端点 |
| `/token` | POST | OIDC Token 端点 |
| `/me` | GET | OIDC UserInfo 端点 |
| `/jwks` | GET | JSON Web Key Set |

### 管理端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin` | GET | 管理面板 |
| `/admin/login` | POST | 管理员登录 |
| `/admin/logout` | POST | 管理员登出 |
| `/admin/clients` | POST | 添加 OIDC 客户端 |
| `/admin/clients/:id/delete` | POST | 删除 OIDC 客户端 |
| `/admin/upstream-providers` | POST | 添加上游 IdP |
| `/admin/upstream-providers/:id/delete` | POST | 删除上游 IdP |
| `/admin/upstream-providers/:id/toggle` | POST | 启用/禁用上游 IdP |
| `/admin/mappings` | POST | 添加身份映射 |
| `/admin/mappings/:id/delete` | POST | 删除身份映射 |

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/clients` | GET | 客户端列表 JSON（需管理员登录） |
| `/api/mappings` | GET | 映射列表 JSON（需管理员登录，支持 `?client_id=` 过滤） |
| `/health` | GET | 健康检查 |

### 内部端点（OIDC 交互流程）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/interaction/:uid` | GET | OIDC 交互处理（登录/授权） |
| `/interaction/:uid/select-idp` | POST | IdP 选择 |
| `/interaction/:uid/federated` | GET | 联合身份处理 |
| `/interaction/:uid/select` | POST | 多映射身份选择 |
| `/sso/:provider/callback` | GET | 上游 IdP 统一回调 |

---

## 数据库表结构

| 表名 | 用途 |
|------|------|
| `oidc_clients` | 下游 OIDC 客户端注册信息 |
| `upstream_providers` | 上游身份提供商配置 |
| `identity_mappings` | 上游身份 → 下游身份映射关系 |

---

## 安全说明

- 🔐 客户端密钥和上游 IdP 密钥使用 **AES-256-GCM** 加密存储
- 🔑 JWKS 签名密钥（RSA256）自动生成并持久化，支持容器重启后密钥不变
- 🔒 加密密钥支持通过 `ENCRYPTION_KEY` 环境变量显式指定，也可首次运行自动生成并保存到 `DATA_DIR/encryption.key`
- 🛡️ OAuth 流程使用 CSRF state 参数和 nonce 防护
- 🍪 Session 使用签名 Cookie + 内存存储，10 分钟过期，自动清理
- 🔏 OIDC 授权自动批准（Consent 自动通过，因为两端均为自有服务）

---

## 故障排除

### 登录后 404 错误
- 检查下游客户端的回调地址是否与下游系统配置完全匹配

### Token 交换失败
- 尝试将客户端的认证方式在 `client_secret_post` 和 `client_secret_basic` 之间切换

### 上游 OIDC 回调报错
- 检查上游 IdP 中的重定向 URI 是否为 `{SSO_BASE_URL}/sso/{provider_id}/callback`
- OIDC 类型的 IdP 确保 Issuer URL 正确且支持 OpenID Connect Discovery

### 上游 OAuth2 回调报错
- 检查 Authorization callback URL 是否配置正确
- 确认 Token URL 和 Userinfo URL 可正常访问
- 检查字段映射是否与上游 API 返回的 JSON 字段一致

### 管理面板无法登录
- 检查 `.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 是否正确配置

### 尚未配置任何上游身份提供商
- 前往 `/admin` 面板添加至少一个上游 IdP
- 上游 IdP 在 v2 中不再通过 `.env` 配置，而是通过管理面板管理

---

## License

MIT
