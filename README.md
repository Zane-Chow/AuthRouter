# Personal SSO Middleware

通用的个人 OIDC 代理中间件 — 支持多个上游身份提供商（Google、GitHub 等）和多个下游网站接入。

## 架构

```
上游 IdP (Google / GitHub / ...)
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

- ✅ 多上游 IdP：Google（OIDC）、GitHub（OAuth2），可扩展
- ✅ 多下游 RP：通过管理面板动态注册 OIDC 客户端
- ✅ 灵活的身份映射：每个客户端独立配置映射关系
- ✅ 智能映射策略：0 映射直通原始身份 / 1 映射自动使用 / 多映射展示选择器
- ✅ 管理面板：客户端管理 + 映射管理
- ✅ Docker Compose 一键部署
- ✅ 自动生成和持久化 JWKS 签名密钥
- ✅ SQLite 持久化数据

---

## 快速部署

### 1. 配置上游 IdP（至少配置一个）

#### Google OAuth2

1. 打开 [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. 创建 OAuth 2.0 Client ID（Web 应用类型）
3. 设置 **已授权的重定向 URI**：`https://sso.zhouhaoze.com/sso/google/callback`
4. 记下 Client ID 和 Client Secret

#### GitHub OAuth2（可选）

1. 打开 [GitHub Developer Settings](https://github.com/settings/developers) → OAuth Apps → New OAuth App
2. 设置 **Authorization callback URL**：`https://sso.zhouhaoze.com/sso/github/callback`
3. 记下 Client ID 和 Client Secret

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入以下关键值：

| 变量 | 说明 |
|------|------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console 获取 |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console 获取 |
| `GITHUB_CLIENT_ID` | GitHub Developer Settings 获取（可选） |
| `GITHUB_CLIENT_SECRET` | GitHub Developer Settings 获取（可选） |
| `ADMIN_PASSWORD` | 管理面板密码 |
| `SESSION_SECRET` | 会话签名密钥（`openssl rand -hex 32`） |

> **注意**：Google 和 GitHub 至少需要配置一个。

### 3. 配置 Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name sso.zhouhaoze.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 4. 启动 SSO 中间件

```bash
docker compose build
docker compose up -d
```

验证服务是否正常：

```bash
# 检查日志
docker compose logs -f

# 验证 OIDC Discovery
curl https://sso.zhouhaoze.com/.well-known/openid-configuration
```

### 5. 注册下游客户端

1. 打开管理面板：`https://sso.zhouhaoze.com/admin`
2. 使用 `.env` 中配置的管理员账号登录
3. 在 **OIDC 客户端** 区域添加客户端，例如：

| 字段 | 示例值 |
|------|--------|
| Client ID | `mailcow-sso` |
| Client Secret | （自行生成强随机字符串） |
| 名称 | `Mailcow 邮件` |
| 回调地址 | `https://mail.zhouhaoze.com/` |
| 认证方式 | `client_secret_post` |

> **注意**：添加客户端后需要 **重启服务** 才能生效（`docker compose restart`）。

### 6. 配置下游系统

以 Mailcow 为例：

1. 进入 Mailcow 管理面板 → **System** → **Configuration** → **Access** → **Identity Provider**
2. 选择 **Generic-OIDC**
3. 填入以下信息：

| 设置 | 值 |
|------|------|
| Authorization Endpoint | `https://sso.zhouhaoze.com/auth` |
| Token Endpoint | `https://sso.zhouhaoze.com/token` |
| User Info Endpoint | `https://sso.zhouhaoze.com/me` |
| Client ID | 与管理面板中添加的 Client ID 一致 |
| Client Secret | 与管理面板中添加的 Client Secret 一致 |
| Scopes | `openid email profile` |

### 7. 添加身份映射（可选）

默认情况下，中间件会**直通**上游 IdP 返回的原始身份（如 Gmail 邮箱），无需配置映射。

如果下游系统需要不同的身份（例如用 Gmail 登录但使用自定义域名邮箱），可以在管理面板添加映射：

| 字段 | 示例值 |
|------|--------|
| 客户端 | `Mailcow 邮件 (mailcow-sso)` |
| 登录平台 | `Google` |
| 来源身份 | `yourname@gmail.com` |
| 目标身份 | `postmaster@zhouhaoze.com` |

映射策略：
- **0 条映射**：直通上游身份（默认）
- **1 条映射**：自动使用映射后的身份
- **多条映射**：弹出选择器让用户选择

### 8. 测试登录

1. 打开下游系统登录页面（如 Mailcow）
2. 点击 SSO 登录按钮
3. 选择登录方式（如只配了一个 IdP 则自动跳转）
4. 完成上游认证后自动返回下游系统

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（文件变更自动重启）
npm run dev
```

---

## 扩展自定义 OAuth2 提供者

系统设计为易于扩展。要添加新的上游 IdP（如 QQ）：

1. 创建 `src/qq-auth.js`，实现 `getAuthUrl(state)` 和 `handleCallback(code, ...)` 接口
2. 在 `src/upstream-providers.js` 中注册新提供者
3. 在 `src/config.js` 中添加对应的环境变量读取和验证
4. 在 `.env` 中配置新的凭据

管理面板和登录选择器会自动识别新增的提供者。

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/openid-configuration` | GET | OIDC Discovery |
| `/auth` | GET | OIDC 授权端点 |
| `/token` | POST | OIDC Token 端点 |
| `/me` | GET | OIDC UserInfo 端点 |
| `/jwks` | GET | JSON Web Key Set |
| `/admin` | GET | 管理面板 |
| `/api/clients` | GET | 客户端列表（需管理员登录） |
| `/api/mappings` | GET | 映射列表（需管理员登录，支持 `?client_id=` 过滤） |
| `/health` | GET | 健康检查 |

---

## 故障排除

### 登录后 404 错误
- 检查下游客户端的回调地址是否与下游系统配置完全匹配

### Token 交换失败
- 尝试将客户端的认证方式在 `client_secret_post` 和 `client_secret_basic` 之间切换

### Google 回调报错
- 检查 Google Cloud Console 中的重定向 URI 是否为 `https://sso.zhouhaoze.com/sso/google/callback`
- 确保 Google OAuth 同意屏幕已发布（或添加了测试用户）

### GitHub 回调报错
- 检查 GitHub OAuth App 中的 Authorization callback URL 是否为 `https://sso.zhouhaoze.com/sso/github/callback`

### 新增客户端不生效
- 通过管理面板添加的客户端需要重启服务才能被 oidc-provider 加载
- 执行 `docker compose restart`
