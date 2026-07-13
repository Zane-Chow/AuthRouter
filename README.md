# AuthRouter

AuthRouter 是一个自托管的 SSO 中间件：它连接多个上游 OIDC / OAuth2 身份提供商，并向下游应用提供统一的 OpenID Connect 登录入口。

本文面向部署用户。推荐的生产流程是：

1. 维护者在本地电脑编写和测试代码。
2. 推送发布标签，GitHub Actions 自动构建 `linux/amd64` 和 `linux/arm64` Docker 镜像，并推送到 GHCR。
3. 服务器只拉取已构建的镜像，配置 `.env`，启动容器，并由 HTTPS 反向代理对外提供服务。

服务器不需要安装 Node.js，也不需要克隆源码或执行 `npm install`。

## 工作方式

~~~text
上游 IdP（Google / GitHub / Keycloak / Azure AD 等）
                         | OIDC / OAuth2
                         v
                      AuthRouter
                         | OpenID Connect
                         v
             下游应用（Wiki / Mail / Blog / 自建服务）
~~~

AuthRouter 可以：

- 通过 Issuer 自动发现标准 OIDC 上游；
- 通过手动端点配置通用 OAuth2 上游；
- 在管理面板动态管理上游 IdP、下游客户端和身份映射；
- 为每个下游应用生成独立的 Client ID 和 Client Secret；
- 使用 SQLite（默认）或 MySQL；
- 加密保存上游和下游 Client Secret；
- 持久化 JWKS、加密密钥、Session 密钥和自动生成的管理员密码。

项目推荐单实例部署。管理员会话和部分 OIDC 临时状态保存在进程内存中，不支持无状态多副本集群。

## 发布镜像

这部分由维护者在本地电脑执行，普通部署用户可以跳过。

GitHub Actions 配置位于 `.github/workflows/docker-publish.yml`，只对匹配 `v*.*` 的标签构建镜像。例如：

~~~bash
git add .
git commit -m "release: prepare v2.0"
git tag -a v2.0 -m "AuthRouter v2.0"
git push origin main
git push origin v2.0
~~~

成功后，镜像地址为：

~~~text
ghcr.io/yiyi-16/authrouter:v2.0
ghcr.io/yiyi-16/authrouter:latest
~~~

Actions 会构建 `linux/amd64` 和 `linux/arm64`。如果 GHCR Package 设置为私有，服务器拉取前需要使用拥有 `read:packages` 权限的 GitHub Token 登录；公开 Package 不需要登录。

## 服务器部署

### 前置条件

- Docker Engine；
- Docker Compose v2；
- 一个解析到服务器的域名；
- 一个可以提供 HTTPS 的反向代理，例如 Nginx、Caddy 或 Traefik；
- 如果使用私有 GHCR Package，需要 GitHub 用户名和 `read:packages` Token。

公网部署必须使用 HTTPS，并设置正确的 `SSO_BASE_URL`。Issuer、上游回调地址和 Cookie 都依赖这个地址。

### 1. 准备部署目录

在服务器上创建目录，并只放置部署文件、`.env` 和反向代理配置：

~~~bash
sudo mkdir -p /opt/authrouter
sudo chown "$USER":"$USER" /opt/authrouter
cd /opt/authrouter
~~~

以 `v2.0` 为例，可以直接从发布标签下载部署文件：

~~~bash
curl -fLO https://raw.githubusercontent.com/YIYI-16/AuthRouter/v2.0/docker-compose.yml
curl -fLO https://raw.githubusercontent.com/YIYI-16/AuthRouter/v2.0/.env.example
curl -fLO https://raw.githubusercontent.com/YIYI-16/AuthRouter/v2.0/nginx.conf
~~~

也可以通过发布包、SCP 或服务器管理面板复制这三个文件。不需要在服务器克隆源码或编译镜像。

### 2. 创建服务器配置

~~~bash
cp .env.example .env
chmod 600 .env
~~~

至少设置：

~~~dotenv
SSO_BASE_URL=https://sso.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
~~~

`SSO_BASE_URL` 必须与用户访问地址完全一致，不能以 `/` 结尾。生产环境建议显式设置 `ADMIN_PASSWORD`；不设置时，程序首次启动会生成密码并保存到 `DATA_DIR/admin.password`。

SQLite 是默认数据库，不需要额外配置。使用 MySQL 时，在 `.env` 中填写已经创建好的数据库和账号：

~~~dotenv
DB_DRIVER=mysql
MYSQL_HOST=mysql.example.internal
MYSQL_PORT=3306
MYSQL_USER=sso
MYSQL_PASSWORD=replace-with-a-database-password
MYSQL_DATABASE=sso
~~~

MySQL 数据库和账号需要提前创建，并允许应用账号连接及创建数据表。容器内的 `localhost` 指向 SSO 容器自身；MySQL 运行在其他主机或容器时，`MYSQL_HOST` 必须填写该服务可被 SSO 容器访问的主机名。

### 3. 登录 GHCR（仅私有镜像需要）

~~~bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
~~~

Token 只需要 `read:packages` 权限，不要写入 `.env` 或提交到仓库。

### 4. 拉取并启动镜像

当前发布版本以 `v2.0` 为例。先拉取镜像，再将它标记为 Compose 文件使用的本地镜像名：

~~~bash
export IMAGE=ghcr.io/yiyi-16/authrouter:v2.0
docker pull "$IMAGE"
docker tag "$IMAGE" authrouter:local
docker compose up -d --force-recreate
~~~

查看启动日志：

~~~bash
docker compose logs -f authrouter
~~~

现有 Compose 配置只将容器端口绑定到服务器的 `127.0.0.1:3000`，不会直接暴露到公网。数据保存在 `sso-data` Volume 中。

### 5. 配置 HTTPS 反向代理

仓库中的 [`nginx.conf`](nginx.conf) 提供了完整示例。核心配置如下：

~~~nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
}
~~~

反向代理的域名、HTTPS 协议和端口必须与 `SSO_BASE_URL` 逐字符一致。不要让 CDN 缓存 `/admin`、`/auth`、`/token` 或回调地址。

### 6. 验证服务

~~~bash
curl https://sso.example.com/health
curl https://sso.example.com/.well-known/openid-configuration
~~~

`/health` 应返回 `status: ok`。Discovery 文档中的 `issuer` 必须与 `SSO_BASE_URL` 完全一致。

### 7. 完成首次配置

1. 打开 `https://sso.example.com/admin` 并登录。
2. 添加至少一个上游 OIDC 或 OAuth2 身份提供商。
3. 在上游平台登记回调地址：`https://sso.example.com/sso/{provider_id}/callback`。
4. 创建下游 OIDC 客户端，并立即保存只展示一次的 Client Secret。
5. 将 Discovery URL、Client ID 和 Client Secret 填入下游应用。
6. 从下游应用发起一次完整登录测试。

完整的上游字段、下游字段和身份映射示例见[上游 / 下游配置指南](docs/upstream-downstream-config.md)。

## 升级与回滚

### 升级到新版本

先确认 GitHub Actions 已经完成对应标签的构建，再在服务器执行：

~~~bash
export IMAGE=ghcr.io/yiyi-16/authrouter:v2.1
docker pull "$IMAGE"
docker tag "$IMAGE" authrouter:local
docker compose up -d --force-recreate
docker compose ps
~~~

升级前请备份 `sso-data` Volume。升级不会修改数据库表中的已有配置，但正在进行中的 OIDC 登录流程可能需要重新发起。

### 回滚到旧版本

~~~bash
export IMAGE=ghcr.io/yiyi-16/authrouter:v2.0
docker pull "$IMAGE"
docker tag "$IMAGE" authrouter:local
docker compose up -d --force-recreate
~~~

不要删除 `sso-data` Volume。`jwks.json`、`encryption.key`、`session.key` 和 `admin.password` 与数据库同等重要，丢失密钥可能导致旧令牌失效或已保存的 Client Secret 无法解密。

## 上游与下游配置

### 上游 OIDC

适用于 Google、Keycloak、Azure AD、Authentik 等支持 OpenID Connect Discovery 的服务：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 标识 | `google` | 唯一标识，并会进入回调 URL |
| 类型 | `oidc` | 使用 Issuer 自动发现 |
| Issuer | `https://accounts.google.com` | 上游服务自己的 Issuer |
| Client ID / Secret | 上游平台签发 | 在上游平台创建 OAuth Client |
| Scope | `openid email profile` | 通常使用默认值 |

回调地址示例：

~~~text
https://sso.example.com/sso/google/callback
~~~

### 上游 OAuth2

需要手动配置 Authorize URL、Token URL、UserInfo URL，以及用户 ID、邮箱、名称和头像字段。若邮箱不在 UserInfo 响应中，可配置额外的 Email URL。

### 下游 OIDC 客户端

优先使用 Discovery URL 自动配置：

| 配置项 | 值 |
| --- | --- |
| Issuer | `https://sso.example.com` |
| Discovery | `https://sso.example.com/.well-known/openid-configuration` |
| Authorization Endpoint | `https://sso.example.com/auth` |
| Token Endpoint | `https://sso.example.com/token` |
| UserInfo Endpoint | `https://sso.example.com/me` |
| JWKS URI | `https://sso.example.com/jwks` |
| Scopes | `openid email profile` |

如果下游 Token 交换提示客户端认证失败，可在管理面板中切换 `client_secret_post` 与 `client_secret_basic`。

### 身份映射

身份映射按“下游客户端 + 上游提供商 + 上游身份”生效：

| 匹配数量 | 登录行为 |
| --- | --- |
| 0 | 直接使用上游身份 |
| 1 | 自动使用映射后的身份 |
| 多条 | 展示账号选择页 |

## 环境变量

所有变量及注释见 [`.env.example`](.env.example)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SSO_BASE_URL` | `http://localhost:3000` | 对外地址及 OIDC Issuer；公网部署必须设置 |
| `SSO_PORT` | `3000` | 容器内部监听端口 |
| `DB_DRIVER` | `sqlite` | `sqlite` 或 `mysql` |
| `ADMIN_USERNAME` | `admin` | 管理面板用户名 |
| `ADMIN_PASSWORD` | 首次启动生成并持久化 | 管理面板密码 |
| `DATA_DIR` | `/app/data` | SQLite、数据库密钥、JWKS 和管理员密码目录 |
| `ENCRYPTION_KEY` | 自动生成并持久化 | 32 字节 hex 或 base64 密钥 |
| `SESSION_SECRET` | 自动生成并持久化 | Session Cookie 签名密钥 |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 上游请求超时毫秒数 |
| `MYSQL_HOST` | `localhost` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | 无 | MySQL 用户名 |
| `MYSQL_PASSWORD` | 无 | MySQL 密码 |
| `MYSQL_DATABASE` | 无 | MySQL 数据库名 |

## 备份与生产检查

发布或升级前至少确认：

- `SSO_BASE_URL` 使用 HTTPS，且没有结尾斜杠；
- `sso-data` Volume 已纳入备份；
- `ADMIN_PASSWORD`、`ENCRYPTION_KEY` 和 `SESSION_SECRET` 未写入公开仓库；
- 服务器端口只监听回环地址或内网地址；
- 反向代理传递 `Host` 和 `X-Forwarded-*`；
- 上游回调地址和下游 Redirect URI 逐字符匹配；
- 已在测试环境验证完整登录、Token 和 UserInfo 流程。

SQLite 与 MySQL 之间不会自动迁移数据。切换数据库前必须自行迁移数据，并同时备份 `DATA_DIR` 中的密钥文件。

## 常见问题

### GitHub Actions 没有运行

工作流只监听 `v*.*` 标签，例如 `v2.0`。标签 `2.0` 不会触发当前工作流。检查 GitHub Actions 页面和对应标签的运行状态。

### 服务器拉取 GHCR 失败

私有 Package 需要先执行 `docker login ghcr.io`，Token 必须拥有 `read:packages` 权限。公开 Package 不需要登录。

### `redirect_uri_mismatch`

检查上游登记的地址是否与 `{SSO_BASE_URL}/sso/{provider_id}/callback` 完全一致，包括协议、域名、端口和结尾斜杠。

### Discovery 的 Issuer 不匹配

检查反向代理域名、`.env` 中的 `SSO_BASE_URL` 和 Discovery 返回的 `issuer` 是否逐字符一致。

### 重启后出现 403 或授权失败

确认 `sso-data` Volume 仍然挂载。已有 Session Cookie 依赖 `session.key`；正在进行中的授权流程在重启后需要重新发起。

### 健康检查失败

~~~bash
docker compose ps
docker compose logs --tail=200 authrouter
curl http://127.0.0.1:3000/health
~~~

## 本地开发（仅贡献者）

服务器部署不需要这一节。贡献者在本地需要 Node.js 20 或更高版本：

~~~bash
npm install
npm run dev
~~~

提交前可以运行：

~~~bash
npm run check
npm test
~~~

## 标准端点

| 路径 | 用途 |
| --- | --- |
| `/health` | 服务健康状态 |
| `/.well-known/openid-configuration` | OIDC Discovery |
| `/auth` | Authorization Endpoint |
| `/token` | Token Endpoint |
| `/me` | UserInfo Endpoint |
| `/jwks` | JSON Web Key Set |
| `/admin` | 管理面板 |

自动化集成应优先依赖标准 OIDC 端点。管理接口属于内部实现，不承诺跨版本稳定。

## License

本项目基于 [MIT License](LICENSE) 开源.
