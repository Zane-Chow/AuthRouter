# 上游 / 下游配置指南

本文档专门说明「上游身份提供商（IdP）」和「下游客户端（RP）」两侧应该怎么配置，
包括：多个上游的回调地址怎么填、下游的 Authorization / Token / UserInfo 等端点怎么填、
Issuer 到底应该填谁的域名。配合 [README.md](../README.md) 一起看。

---

## 0. 先分清两个方向

```
上游 IdP (Google / GitHub / Keycloak / ...)
         ↕ ①中间件是"客户端" (OAuth2 / OIDC Client)
   ┌─────────────────────┐
   │   SSO 中间件         │   https://sso.example.com
   │  (oidc-provider)     │
   └─────────────────────┘
         ↕ ②中间件是"服务端" (OIDC Provider / IdP)
下游 RP (Mailcow / Wiki / Blog / ...)
```

- **① 上游方向**：中间件去 Google/GitHub/Keycloak 那里"登录"，中间件是 *client*。
  这一侧要填的是 **Google/GitHub 自己的** Authorize/Token/Userinfo 地址（或 Issuer）。
- **② 下游方向**：Mailcow/Wiki 来中间件这里"登录"，中间件是 *IdP*。
  这一侧要填的是 **中间件自己的** Authorization/Token/UserInfo 端点，跟 Google 无关。

两个方向的"Issuer"含义完全不同，这是最容易搞混的地方，第 3 节会专门讲清楚。

---

## 1. 上游 IdP 配置（中间件作为 OAuth2/OIDC 客户端）

### 1.1 回调地址不是固定的 `/google/callback`

代码里的路由是一条**通配路由**（`src/index.js`）：

```js
router.get('/sso/:provider/callback', ...)
```

`:provider` 会被替换成你在管理面板"标识"字段里填的那个值（`provider_id`）。也就是说：

- 你在管理面板新增上游 IdP 时填 **标识 = `google`** → 回调地址是
  `https://sso.example.com/sso/google/callback`
- 你再新增一个上游，**标识 = `github`** → 回调地址是
  `https://sso.example.com/sso/github/callback`
- 再加一个自建 Keycloak，**标识 = `company-sso`** → 回调地址是
  `https://sso.example.com/sso/company-sso/callback`

`/sso/google/callback` **并不是代码里写死只给 Google 用的路径**，只是因为标识刚好叫
`google` 才长这样。标识可以是任意 URL 友好的字符串（字母/数字/短横线），只要保证：

1. 在整个中间件里唯一（数据库对 `provider_id` 做了唯一约束）；
2. 和你去上游控制台（Google Cloud Console / GitHub OAuth App / Keycloak Client 等）
   登记的回调地址中的那一段完全一致（区分大小写）。

**通用公式：**

```
回调地址 = {SSO_BASE_URL}/sso/{你填的标识}/callback
```

添加/修改每一个上游 IdP 后，都要去**该上游自己的开发者后台**，把这个地址登记为
"Authorized redirect URI" / "Authorization callback URL" / "Valid Redirect URIs"（各家叫法不同）。
一个上游只需要登记一次，之后除非改标识或改域名不需要再改。

### 1.2 OIDC 类型（自动发现）—— 只需填对方的 Issuer

适用于任何支持 OpenID Connect Discovery（`/.well-known/openid-configuration`）的 IdP，
比如 Google、Keycloak、Azure AD、Okta、Authelia、Authentik 等。这类不需要手填
Authorize/Token/Userinfo 三个端点，中间件会自动向 `{issuer}/.well-known/openid-configuration`
请求发现文档拿到这些地址（见 `src/oidc-auth.js` 的 `Issuer.discover(row.issuer)`）。

| 字段 | 说明 | 示例（Google） | 示例（自建 Keycloak） |
|------|------|------|------|
| 标识 (provider_id) | URL 友好，决定回调路径 | `google` | `keycloak` 或 `company-sso` |
| 名称 | 登录页显示名 | `Google` | `公司统一登录` |
| 类型 | 固定选 `oidc` | `oidc` | `oidc` |
| **Issuer** | **对方的** Issuer，中间件会去它的 discovery 文档发现端点 | `https://accounts.google.com` | `https://keycloak.example.com/realms/myrealm` |
| Client ID / Secret | 在对方后台创建 OAuth 客户端后拿到 | — | — |
| Scope | 默认 `openid email profile` 即可 | `openid email profile` | `openid email profile` |
| 回调地址（自动生成，无需手填，去对方后台登记） | — | `https://sso.example.com/sso/google/callback` | `https://sso.example.com/sso/keycloak/callback` |

> Keycloak 的 Issuer 一定是**某个 realm** 的地址，格式固定为
> `{Keycloak 根地址}/realms/{realm 名称}`，不是 Keycloak 服务器的根域名。
> Azure AD 类似，是 `https://login.microsoftonline.com/{tenant-id}/v2.0`。

### 1.3 OAuth2 类型（手动填端点）—— 没有标准 Discovery 的上游

适用于不支持 OIDC Discovery、只提供普通 OAuth2 接口的服务，比如 GitHub。这类需要手动
填三个地址 + 字段映射：

| 字段 | 说明 | 示例（GitHub） |
|------|------|------|
| 标识 | 同上，决定回调路径 | `github` |
| 类型 | 固定选 `oauth2` | `oauth2` |
| Authorize URL | 对方的用户授权页地址 | `https://github.com/login/oauth/authorize` |
| Token URL | 对方用 code 换 token 的地址 | `https://github.com/login/oauth/access_token` |
| Userinfo URL | 对方拿用户信息的地址 | `https://api.github.com/user` |
| Email URL（可选） | 有些平台邮箱要单独接口拿（GitHub 就是） | `https://api.github.com/user/emails` |
| Scope | 按对方文档 | `user:email` |
| 字段映射 | 把对方返回 JSON 的字段名映射成中间件内部统一的 `id/email/name/avatar` | `id→id`, `email→email`, `name→login`, `avatar→avatar_url` |
| 回调地址（去对方后台登记） | — | `https://sso.example.com/sso/github/callback` |

### 1.4 完整示例：同时接入 Google + GitHub + 自建 Keycloak

假设 `SSO_BASE_URL=https://sso.example.com`，管理面板里加了三个上游：

| 标识 | 类型 | 需要在对方后台登记的回调地址 |
|------|------|------|
| `google` | oidc | `https://sso.example.com/sso/google/callback` |
| `github` | oauth2 | `https://sso.example.com/sso/github/callback` |
| `company-sso` | oidc | `https://sso.example.com/sso/company-sso/callback` |

三个互不影响，用户在登录选择页会看到三个按钮（因为配置了多个上游），点哪个就走哪个的
回调路径。如果只配置了一个上游，中间件会跳过选择页直接跳转过去。

---

## 2. 下游 RP 配置（中间件作为 OIDC Provider）

### 2.1 端点是"全局唯一"的，不像上游那样按 provider 区分

这是和上游最大的不同点：**不管你在管理面板注册了多少个下游客户端（Mailcow、Wiki、
Blog…），它们共用同一套 OIDC 端点**，没有类似 `/sso/{client}/...` 这种按客户端区分的路径。
区分不同下游客户端靠的是各自独立的 **Client ID / Client Secret / redirect_uri**，不是端点路径。

这些端点由 `oidc-provider` 库按 OIDC 标准固定挂载在中间件根路径下（`src/provider.js` +
`src/index.js`）：

| 配置到下游系统里的字段 | 固定填法 |
|------|------|
| Authorization Endpoint | `https://sso.example.com/auth` |
| Token Endpoint | `https://sso.example.com/token` |
| User Info Endpoint | `https://sso.example.com/me` |
| JWKS URI | `https://sso.example.com/jwks` |
| Discovery / well-known URL | `https://sso.example.com/.well-known/openid-configuration` |

也就是说，无论你之后加多少个下游客户端，这五行 URL **永远长一个样**（把 `sso.example.com`
换成你自己的域名即可）。新增客户端时只需要在下游系统里填自己的 Client ID / Secret /
Redirect URI，端点部分照抄上表，或者干脆用最下面的 Discovery URL 让下游系统自动拉取全部端点
（很多现代系统，如支持"OIDC 自动发现"的应用，只需填这一个 URL 就够了）。

### 2.2 Issuer 该填谁的域名？—— 填你自己中间件的域名，不是 Google 的

**下游系统配置里要求填的 "Issuer"，永远是中间件自己对外暴露的域名，即
`.env` 里的 `SSO_BASE_URL`，和 Google/GitHub 完全无关。**

代码依据（`src/provider.js`）：

```js
const issuer = config.sso.baseUrl || `http://localhost:${config.sso.port}`;
const provider = new Provider(issuer, { ... });
```

`oidc-provider` 库会把这个 `issuer` 值原样写进它签发的每个 ID Token 的 `iss` 字段，也会写进
`/.well-known/openid-configuration` 的 `issuer` 字段。下游系统在做 discovery 或校验
ID Token 时，会**逐字符比对**这个 issuer 值，所以必须和 `SSO_BASE_URL` **完全一致**：

- 协议要一致（生产环境用 `https://`，不能漏）
- 不能有多余的结尾斜杠（`https://sso.example.com` 而不是
  `https://sso.example.com/`）
- 域名大小写、端口都要和 `SSO_BASE_URL` 一字不差

**举例：** 如果 `.env` 里配的是

```
SSO_BASE_URL=https://sso.example.com
```

那么：

- 下游系统里 "Issuer" 一栏填 `https://sso.example.com`
- Authorization/Token/UserInfo 端点分别是
  `https://sso.example.com/auth`、`/token`、`/me`
- 如果 `SSO_BASE_URL` 没配（本地开发默认），Issuer 就会是
  `http://localhost:3000`，这时候只能给本地能访问到这个地址的下游用，公网下游用不了。

> 对比一下：上游配置里"Issuer"（1.2 节）填的是 **Google/Keycloak 自己的** Issuer，
> 中间件拿它去做 discovery、去发现 Google 的端点；下游配置里"Issuer"填的是
> **中间件自己的** Issuer，下游拿它来发现中间件的端点。两个方向的字段名一样，含义相反，
> 千万别填反。

### 2.3 完整示例：Mailcow + 自建 Wiki 两个下游

假设域名同上是 `https://sso.example.com`，管理面板注册了两个客户端：

**客户端 A（Mailcow）**
- 回调地址：`https://mail.example.com/oauth2/callback`（Mailcow 自己的回调路径，填它要求的格式）
- Client ID / Secret：由中间件自动生成，创建后复制填入 Mailcow

**客户端 B（Wiki）**
- 回调地址：`https://wiki.example.com/auth/oidc/callback`
- Client ID / Secret：另一套，自动生成

在 Mailcow 和 Wiki 两边的 OIDC 设置里，**Authorization/Token/UserInfo/Issuer 这几行填的内容
完全相同**（都是 `sso.example.com` 那几个固定端点），唯一不同的是各自的 Client ID/Secret
和它们自己的回调地址：

| 配置项 | Mailcow | Wiki |
|--------|---------|------|
| Issuer | `https://sso.example.com` | `https://sso.example.com` |
| Authorization Endpoint | `https://sso.example.com/auth` | `https://sso.example.com/auth` |
| Token Endpoint | `https://sso.example.com/token` | `https://sso.example.com/token` |
| User Info Endpoint | `https://sso.example.com/me` | `https://sso.example.com/me` |
| Client ID | `abc123...`（Mailcow 专属） | `xyz789...`（Wiki 专属） |
| Client Secret | 对应的 secret | 对应的 secret |
| Redirect URI | `https://mail.example.com/oauth2/callback` | `https://wiki.example.com/auth/oidc/callback` |
| Scopes | `openid email profile` | `openid email profile` |

---

## 3. 常见误区 / FAQ

**Q: 我加了第二个上游 IdP，是不是还要改代码加一条新路由？**
不需要。回调路由是通配的 `/sso/:provider/callback`，加几个上游都用这一条路由，靠标识区分。

**Q: 上游的 Issuer 和下游的 Issuer 能填一样吗？**
不能，含义相反。上游 Issuer = 对方（Google 等）的域名；下游 Issuer = 你中间件自己的域名
（`SSO_BASE_URL`）。

**Q: 不同下游客户端的 Authorization/Token/UserInfo 端点是不是要分别配置？**
不需要，也没法配置成不同的——这三个端点在中间件里是全局唯一的，所有下游客户端共用，
下游之间只靠各自的 Client ID/Secret/Redirect URI 区分。

**Q: Issuer 后面要不要加斜杠？**
不要。`SSO_BASE_URL` 和最终对外的 Issuer 都不带结尾斜杠，下游校验 `iss` 声明时是精确字符串
比较，多一个斜杠就会校验失败。

**Q: 本地开发环境 `SSO_BASE_URL` 不填会怎样？**
Issuer 会退化成 `http://localhost:{SSO_PORT}`，只适合本机联调，接入公网上游（如 Google）和
公网下游前必须配好正式域名的 `SSO_BASE_URL` 并使用 HTTPS（Google 等大多数上游拒绝
非 localhost 的 http 回调）。

---

## 4. 排错清单

| 现象 | 排查方向 |
|------|------|
| 点登录后上游报 `redirect_uri_mismatch` | 上游后台登记的回调地址和 `{SSO_BASE_URL}/sso/{标识}/callback` 没有逐字符对上（协议、域名、标识拼写、结尾斜杠） |
| 上游 OIDC 加不进去 / discovery 失败 | 检查填的 Issuer 是否就是可以直接拼出 `/.well-known/openid-configuration` 并访问成功的地址 |
| 下游报 `iss` 不匹配 / discovery 拿到的 issuer 和期望不一致 | 检查下游系统里填的 Issuer 是否和 `.env` 里 `SSO_BASE_URL` 完全一致（协议、大小写、无结尾斜杠） |
| 下游登录后 404 或跳转失败 | 检查该下游客户端在管理面板里登记的回调地址是否与下游系统实际使用的回调地址完全一致 |
| Token 交换报认证失败 | 尝试切换该下游客户端的认证方式（`client_secret_post` ↔ `client_secret_basic`） |
