# AuthRouter 管理 API 文档

AuthRouter 提供 `/api/*` JSON 管理接口，可接入上游 OIDC / OAuth2 身份提供商、配置下游 OIDC 客户端和维护身份映射。请求通过 `Authorization: Bearer <API Token>` 鉴权，无需管理员 Cookie、CSRF Token 或解析 HTML。

部署说明见 [README](../README.md)，登录接入概念见 [上游与下游配置指南](upstream-downstream-config.md)。

## 开启 API 和生成 Token

1. 使用管理员账号登录 `/admin`。
2. 在「管理 API」区域点击「生成 API Token」，立即复制保存本次显示的 Token。
3. 点击「开启 API」。此后可使用该 Token 调用接口。

API 默认关闭。生成 Token 不会自动开启 API；没有 Token 时不能在后台开启。开关和 Token 的 SHA-256 摘要保存在数据库中，重启后仍有效。Token 明文只在生成时显示一次，不会写入数据库或后续管理页面。

当前使用一个全局管理 Token，拥有下表全部接口的权限。点击「重新生成 Token」会立即使旧 Token 失效，并保持当前开关状态。点击「关闭 API」会拒绝所有管理 API 请求；重新开启后仍可使用当前 Token。管理员退出登录不影响已开启的 API。

API 开关和 Token 只能通过管理员后台管理，后台操作仍需要管理员会话和 CSRF 验证。API Token 不能用于登录后台，下游 OIDC Access Token 也不能替代管理 Token。

## 请求和响应约定

- Base URL 为 `SSO_BASE_URL`，例如 `https://sso.example.com`，不带结尾 `/`。
- 每次请求携带 `Authorization: Bearer <API Token>`，Token 不接受 URL 查询参数或 Cookie 传递。
- POST 和 PATCH 必须使用 `Content-Type: application/json`，请求体为 JSON 对象，最大 256 KiB。DELETE 无需请求体。
- GET 返回 JSON 对象或数组；POST 创建成功返回 201 和 `Location`；PATCH 返回 200；DELETE 返回 204，无响应体。
- PATCH 是部分更新，未提交的字段保留原值，包括 Secret 和客户端上游白名单。空 PATCH 对象和未知字段返回 400。
- 布尔字段使用 JSON `true` / `false`，不接受字符串 `"true"` / `"false"` 或数字 0 / 1。
- 查询和更新响应不包含 `client_secret`。下游创建和 Secret 重置是例外，只在当次响应中返回新 Secret。
- 所有 API 响应使用 `Cache-Control: no-store`，并包含 `X-Request-Id`，不生成管理员会话 Cookie。

下表的上游 `:id` 和映射 `:id` 为正整数记录 ID；下游 `:clientId` 为自动生成的 `client_id` 字符串。上游 `provider_id` 是 `google`、`github` 这样的标识，供回调地址、白名单和身份映射引用。

## 接口总览

| 方法 | 路径 | 功能 | 成功状态 |
| --- | --- | --- | --- |
| GET | `/api/upstream-providers` | 查询全部上游 | 200 |
| POST | `/api/upstream-providers` | 创建上游 | 201 |
| GET | `/api/upstream-providers/:id` | 查询一个上游 | 200 |
| PATCH | `/api/upstream-providers/:id` | 更新上游配置或启用状态 | 200 |
| DELETE | `/api/upstream-providers/:id` | 删除上游 | 204 |
| GET | `/api/clients` | 查询全部下游 | 200 |
| POST | `/api/clients` | 创建下游并返回凭据 | 201 |
| GET | `/api/clients/:clientId` | 查询一个下游 | 200 |
| PATCH | `/api/clients/:clientId` | 更新下游配置或启用状态 | 200 |
| POST | `/api/clients/:clientId/reset-secret` | 重置下游 Secret | 200 |
| DELETE | `/api/clients/:clientId` | 删除下游及其映射和白名单 | 204 |
| GET | `/api/mappings` | 查询全部映射，可按 `client_id` 筛选 | 200 |
| POST | `/api/mappings` | 创建映射 | 201 |
| GET | `/api/mappings/:id` | 查询一个映射 | 200 |
| PATCH | `/api/mappings/:id` | 更新映射 | 200 |
| DELETE | `/api/mappings/:id` | 删除映射 | 204 |

`GET /health` 和标准 OIDC 端点不受管理 API 开关影响，仍可按原有方式调用。

## 接入上游

### 上游字段

创建使用 `POST /api/upstream-providers`，部分更新使用 `PATCH /api/upstream-providers/:id`。

| 字段 | 创建时必填 | 说明 |
| --- | --- | --- |
| `provider_id` | 是 | 唯一标识，1 至 50 字符，首字符为字母或数字，其余可含字母、数字、`_`、`-`；创建后不能修改 |
| `display_name` | 是 | 登录页显示名，最长 255 字符 |
| `type` | 是 | `oidc` 或 `oauth2` |
| `client_id` | 是 | 上游平台签发的 Client ID，最长 255 字符 |
| `client_secret` | 是 | 上游平台签发的 Client Secret，最长 4096 字符；更新时省略则保留 |
| `issuer` | OIDC 必填 | 上游自己的 Issuer，HTTP 或 HTTPS URL |
| `authorize_url` | OAuth2 必填 | 上游授权端点 |
| `token_url` | OAuth2 必填 | 上游 Token 端点 |
| `userinfo_url` | OAuth2 必填 | 上游用户信息端点 |
| `email_url` | 否 | OAuth2 补充邮箱端点；可用 `null` 清空 |
| `scope` | 否 | OIDC 默认 `openid email profile`，OAuth2 默认空字符串，最长 255 字符 |
| `field_id` | 否 | OAuth2 用户 ID 字段，默认 `sub` |
| `field_email` | 否 | OAuth2 邮箱字段，默认 `email` |
| `field_name` | 否 | OAuth2 名称字段，默认 `name` |
| `field_avatar` | 否 | OAuth2 头像字段，默认 `picture` |
| `icon` | 否 | 登录页图标标识，默认 `generic`，最长 32 字符 |
| `enabled` | 否 | 默认 `true`；PATCH 提交明确状态，重复提交不会反转状态 |

URL 字段最长 512 字符，必须使用 HTTP 或 HTTPS。`field_*` 最长 64 字符，读取 OAuth2 用户信息的顶层字段；OIDC 使用标准 `sub`、`email`、`name`、`picture`，不使用这些自定义字段。

上游回调地址为 `{SSO_BASE_URL}/sso/{provider_id}/callback`，需要在上游平台登记。添加接口只保存配置，不执行上游连通性验证，配置后仍需从下游应用完成一次实际登录。

### 创建 OIDC 上游

请求体示例：

```json
{
  "provider_id": "google",
  "display_name": "Google",
  "type": "oidc",
  "issuer": "https://accounts.google.com",
  "client_id": "replace-with-upstream-client-id",
  "client_secret": "replace-with-upstream-client-secret",
  "scope": "openid email profile",
  "icon": "google",
  "enabled": true
}
```

成功响应返回 `id`、`provider_id`、显示名称、端点、Scope、字段配置、布尔 `enabled` 和创建时间等配置，不包含明文或加密后的 `client_secret`。

### 创建 OAuth2 上游

GitHub 示例请求体如下，回调地址为 `{SSO_BASE_URL}/sso/github/callback`：

```json
{
  "provider_id": "github",
  "display_name": "GitHub",
  "type": "oauth2",
  "authorize_url": "https://github.com/login/oauth/authorize",
  "token_url": "https://github.com/login/oauth/access_token",
  "userinfo_url": "https://api.github.com/user",
  "email_url": "https://api.github.com/user/emails",
  "client_id": "replace-with-github-client-id",
  "client_secret": "replace-with-github-client-secret",
  "scope": "user:email",
  "field_id": "id",
  "field_email": "email",
  "field_name": "login",
  "field_avatar": "avatar_url",
  "icon": "github"
}
```

### 更新和删除上游

PATCH 可提交新的 `client_secret`，也可以只更新名称、端点或 `enabled`。修改会清理上游 OIDC 缓存，不需要重启。修改 `type` 时需保证合并后的配置满足新类型的必填字段。

删除上游会保留引用其 `provider_id` 的映射和下游白名单，以免删除最后一个允许的上游后意外放开客户端权限。需要按实际意图另行修改白名单和映射。

## 配置下游

### 下游字段

创建使用 `POST /api/clients`，部分更新使用 `PATCH /api/clients/:clientId`。

| 字段 | 创建时必填 | 说明 |
| --- | --- | --- |
| `client_name` | 是 | 下游名称，最长 255 字符 |
| `redirect_uris` | 是 | 推荐使用字符串数组，1 至 20 个绝对 URI，不得包含 `#fragment`；也支持逗号或换行分隔的字符串 |
| `token_endpoint_auth_method` | 否 | `client_secret_post`（默认）、`client_secret_basic` 或 `none` |
| `scope` | 否 | 默认 `openid email profile`，最长 255 字符 |
| `allowed_providers` | 否 | 上游 `provider_id` 数组，最多 100 项；创建时省略或传 `[]` 表示允许全部已启用上游 |
| `enabled` | 否 | 默认 `true`；禁用后不再接受该客户端发起新的 OIDC 授权 |

Client ID 和 Secret 自动生成，不能自行指定。PATCH 中省略 `allowed_providers` 会保留白名单；显式传 `[]` 才会清空白名单、放开为全部已启用上游。白名单中的上游必须存在，登录时还需处于启用状态。

`redirect_uris` 会去重，输入总长度最多 8192 字符。客户端固定使用 `authorization_code` 和 `response_type=code`，这些管理接口不配置 Refresh Token 授权。

### 创建响应示例

```json
{
  "id": 1,
  "client_id": "<自动生成的 client_id>",
  "client_name": "Wiki",
  "redirect_uris": ["https://wiki.example.com/oauth/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_post",
  "scope": "openid email profile",
  "enabled": true,
  "created_at": "2026-10-03 00:00:00",
  "allowed_providers": ["google"],
  "client_secret": "<本次生成的明文 Secret>"
}
```

查询和 PATCH 响应结构相同，但不包含 `client_secret`。数组字段直接返回 JSON 数组，无需再次 JSON 解码。

将生成的凭据配置到下游应用，Issuer 使用 `{SSO_BASE_URL}`，Discovery URL 使用 `{SSO_BASE_URL}/.well-known/openid-configuration`。

### 重置 Secret

POST `/api/clients/:clientId/reset-secret`，请求体为 `{}`。响应如下：

```json
{
  "client_id": "<client_id>",
  "client_secret": "<新的明文 Secret>"
}
```

立即保存并同步到下游应用，原 Secret 无法再用于新的客户端认证。Secret 重置不改变客户端名称、回调、白名单或启用状态。

## 配置身份映射

### 映射字段

创建使用 `POST /api/mappings`，部分更新使用 `PATCH /api/mappings/:id`。

| 字段 | 创建时必填 | 说明 |
| --- | --- | --- |
| `client_id` | 是 | 下游 `client_id`，最长 100 字符，必须存在 |
| `provider` | 是 | 上游 `provider_id`，如 `google`；不是 `oidc` 或 `oauth2` |
| `provider_identity` | 是 | 来源身份，最长 190 字符，去除首尾空白并转为小写 |
| `target_identity` | 是 | 目标身份，最长 190 字符，同样去空白并转为小写 |
| `display_name` | 否 | 多账号选择时的显示名，最长 255 字符，可用 `null` 清空 |

创建或更新时，上游必须已启用且当前下游有权使用它。唯一键为 `(client_id, provider, provider_identity, target_identity)`；完全重复时返回 409。同一来源身份可映射到多个目标身份。

登录使用归一化后的上游 `profile.email` 匹配来源身份，不能直接填写 OIDC `sub` 或 OAuth2 数字用户 ID。OIDC 上游应返回邮箱；OAuth2 使用用户信息邮箱或补充邮箱端点，无法取得邮箱时使用 `{上游用户ID}@{provider_id}`，例如 `12345@github`。

0 条匹配时使用来源身份；1 条时自动使用目标身份；多条时展示账号选择页。目标身份作为下游 OIDC `sub`，请求 `email` Scope 时也作为 `email` 返回。映射按下游客户端隔离。

### 映射响应示例

```json
{
  "id": 1,
  "client_id": "<client_id>",
  "provider": "google",
  "provider_identity": "alice@gmail.com",
  "target_identity": "alice@example.com",
  "display_name": "Alice 的 Wiki 账号",
  "created_at": "2026-10-03 00:00:00"
}
```

`GET /api/mappings?client_id=<client_id>` 按下游筛选，未找到匹配记录返回 `[]`。查询单条不存在的映射返回 404。

## 完整 curl 调用示例

在后台生成 Token 并开启 API 后，以下示例依次创建 Google 上游、Wiki 下游和 Alice 的身份映射。需要 Bash、curl 和 jq。把端点、凭据及来源邮箱替换为实际配置；`BASE_URL` 必须与服务端地址一致。

```bash
set -euo pipefail
umask 077
BASE_URL='https://sso.example.com'
read -rsp 'API Token: ' API_TOKEN
printf '\n'
WORK_DIR=$(mktemp -d)

# 所有写入均使用 JSON，所有请求均使用 Bearer Token。
api() {
  local method="$1" route="$2"
  shift 2
  curl -fsS -X "$method" "$BASE_URL$route" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H 'Content-Type: application/json' "$@"
}

# 先在 Google 登记回调地址：{BASE_URL}/sso/google/callback。
api POST '/api/upstream-providers' --data '{
  "provider_id": "google",
  "display_name": "Google",
  "type": "oidc",
  "issuer": "https://accounts.google.com",
  "client_id": "replace-with-upstream-client-id",
  "client_secret": "replace-with-upstream-client-secret"
}' > "$WORK_DIR/provider.json"
PROVIDER_ID=$(jq -er '.id' "$WORK_DIR/provider.json")

api POST '/api/clients' --data '{
  "client_name": "Wiki",
  "redirect_uris": ["https://wiki.example.com/oauth/callback"],
  "token_endpoint_auth_method": "client_secret_post",
  "allowed_providers": ["google"]
}' > "$WORK_DIR/client.json"
CLIENT_ID=$(jq -er '.client_id' "$WORK_DIR/client.json")
# client.json 含明文 Secret，请保存到自己的密钥管理系统。

jq -n --arg id "$CLIENT_ID" '{
  client_id: $id,
  provider: "google",
  provider_identity: "alice@gmail.com",
  target_identity: "alice@example.com",
  display_name: "Alice 的 Wiki 账号"
}' > "$WORK_DIR/mapping-input.json"
api POST '/api/mappings' --data-binary "@$WORK_DIR/mapping-input.json" \
  > "$WORK_DIR/mapping.json"
MAPPING_ID=$(jq -er '.id' "$WORK_DIR/mapping.json")

# 查询验证，不会返回已有 Secret。
api GET '/api/upstream-providers' | jq .
api GET "/api/clients/$CLIENT_ID" | jq .
api GET "/api/mappings?client_id=$CLIENT_ID" | jq .
```

后续可按需部分更新，无需重新提交其他字段：

```bash
api PATCH "/api/upstream-providers/$PROVIDER_ID" \
  --data '{"display_name":"Google 登录"}' | jq .
api PATCH "/api/clients/$CLIENT_ID" \
  --data '{"client_name":"公司 Wiki"}' | jq .
api PATCH "/api/mappings/$MAPPING_ID" \
  --data '{"target_identity":"alice@company.example"}' | jq .

# 明确禁用或启用上游，重复提交相同状态不会反转。
api PATCH "/api/upstream-providers/$PROVIDER_ID" --data '{"enabled":false}' | jq .
api PATCH "/api/upstream-providers/$PROVIDER_ID" --data '{"enabled":true}' | jq .

# 重置下游 Secret：保存当次响应，再更新下游应用配置。
api POST "/api/clients/$CLIENT_ID/reset-secret" --data '{}' \
  > "$WORK_DIR/new-client-secret.json"
```

删除操作按需执行，成功返回 204，无 JSON 响应体：

```bash
api DELETE "/api/mappings/$MAPPING_ID"
api DELETE "/api/clients/$CLIENT_ID"
api DELETE "/api/upstream-providers/$PROVIDER_ID"
```

客户端凭据和新 Secret 已保存到自己的密钥管理系统后，清理临时响应并移除当前 Shell 中的 Token：

```bash
rm -rf -- "$WORK_DIR"
unset API_TOKEN
```

## 错误响应

所有 API 错误返回 JSON，不重定向到后台页面：

```json
{
  "error": "authentication_required",
  "message": "API Token 缺失或无效",
  "requestId": "<请求 ID>"
}
```

| HTTP 状态 | error | 原因 |
| --- | --- | --- |
| 400 | `validation_error` | 字段无效、未知字段、空更新或 JSON 无法解析 |
| 401 | `authentication_required` | API Token 缺失、无效或已被轮换；响应含 `WWW-Authenticate: Bearer` |
| 403 | `api_disabled` | 后台未开启或已关闭管理 API |
| 404 | `not_found` | 资源或路由不存在，包括重复删除已不存在的资源 |
| 405 | `method_not_allowed` | 对已存在的路径使用不支持的 HTTP 方法 |
| 409 | `conflict` | 上游标识或身份映射重复 |
| 413 | `payload_too_large` | 请求体超过 256 KiB |
| 415 | `unsupported_media_type` | POST / PATCH 未使用 `application/json` |
| 500 | `internal_error` | 服务端内部错误，可通过请求 ID 查询日志 |

API 关闭时优先返回 403，不先校验 Token。字段或权限校验失败不会按请求内容执行写入。创建下游会生成新 ID，Secret 重置会生成新 Secret；若超时或连接中断，应先查询配置，避免盲目重复创建或轮换。

## 从旧接口迁移

此前 `/api/clients` 和 `/api/mappings` 依赖管理员 Cookie。现在所有 `/api/*` 路径统一使用后台开关和 Bearer Token，不再接受管理员 Cookie 鉴权。客户端数组字段从 JSON 编码字符串改为直接返回 JSON 数组，普通查询不再返回遮蔽的 `client_secret` 字段。

管理后台原有 `/admin/...` 表单操作继续使用 Cookie 和 CSRF。新的 JSON API 中，客户端认证方式字段统一为 `token_endpoint_auth_method`，映射上游字段统一为 `provider`。自动化脚本应按本文的新字段和响应格式调用。
