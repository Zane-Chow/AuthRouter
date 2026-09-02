/**
 * Table DDL for both supported database backends. Kept as one statement per
 * table (rather than one big multi-statement string) so both drivers can run
 * them the same way (loop + execute one at a time).
 *
 * MySQL notes:
 * - TEXT/BLOB columns can't carry a literal DEFAULT — columns needing a
 *   default are sized as VARCHAR instead.
 * - identity_mappings' unique/lookup key columns are kept short enough that
 *   the composite key stays under InnoDB's 3072-byte index key limit under
 *   utf8mb4 (4 bytes/char).
 */

export const sqliteSchema = {
  oidc_clients: `
    CREATE TABLE IF NOT EXISTS oidc_clients (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id                   TEXT    NOT NULL UNIQUE,
      client_secret               TEXT    NOT NULL,
      client_name                 TEXT    NOT NULL,
      redirect_uris               TEXT    NOT NULL,
      grant_types                 TEXT    NOT NULL DEFAULT '["authorization_code"]',
      response_types              TEXT    NOT NULL DEFAULT '["code"]',
      token_endpoint_auth_method  TEXT    NOT NULL DEFAULT 'client_secret_post',
      scope                       TEXT    NOT NULL DEFAULT 'openid email profile',
      enabled                     INTEGER NOT NULL DEFAULT 1,
      created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

  upstream_providers: `
    CREATE TABLE IF NOT EXISTS upstream_providers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id    TEXT    NOT NULL UNIQUE,
      display_name   TEXT    NOT NULL,
      type           TEXT    NOT NULL,
      issuer         TEXT,
      authorize_url  TEXT,
      token_url      TEXT,
      userinfo_url   TEXT,
      email_url      TEXT,
      client_id      TEXT    NOT NULL,
      client_secret  TEXT    NOT NULL,
      scope          TEXT    NOT NULL DEFAULT 'openid email profile',
      field_id       TEXT    NOT NULL DEFAULT 'sub',
      field_email    TEXT    NOT NULL DEFAULT 'email',
      field_name     TEXT    NOT NULL DEFAULT 'name',
      field_avatar   TEXT    NOT NULL DEFAULT 'picture',
      icon           TEXT    NOT NULL DEFAULT 'generic',
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

  client_upstream_permissions: `
    CREATE TABLE IF NOT EXISTS client_upstream_permissions (
      client_id    TEXT NOT NULL,
      provider_id  TEXT NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (client_id, provider_id),
      FOREIGN KEY (client_id) REFERENCES oidc_clients(client_id) ON DELETE CASCADE
    )`,

  identity_mappings: `
    CREATE TABLE IF NOT EXISTS identity_mappings (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id         TEXT    NOT NULL,
      provider          TEXT    NOT NULL,
      provider_identity TEXT    NOT NULL,
      target_identity   TEXT    NOT NULL,
      display_name      TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, provider, provider_identity, target_identity),
      FOREIGN KEY (client_id) REFERENCES oidc_clients(client_id) ON DELETE CASCADE
    )`,
};

export const sqliteIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_mappings_lookup ON identity_mappings(client_id, provider, provider_identity)`,
];

export const mysqlSchema = {
  oidc_clients: `
    CREATE TABLE IF NOT EXISTS oidc_clients (
      id                          INT AUTO_INCREMENT PRIMARY KEY,
      client_id                   VARCHAR(100)  NOT NULL UNIQUE,
      client_secret               TEXT          NOT NULL,
      client_name                 VARCHAR(255)  NOT NULL,
      redirect_uris                TEXT         NOT NULL,
      grant_types                 VARCHAR(255)  NOT NULL,
      response_types              VARCHAR(255)  NOT NULL,
      token_endpoint_auth_method  VARCHAR(64)   NOT NULL DEFAULT 'client_secret_post',
      scope                       VARCHAR(255)  NOT NULL DEFAULT 'openid email profile',
      enabled                     TINYINT(1)    NOT NULL DEFAULT 1,
      created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  upstream_providers: `
    CREATE TABLE IF NOT EXISTS upstream_providers (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      provider_id    VARCHAR(50)   NOT NULL UNIQUE,
      display_name   VARCHAR(255)  NOT NULL,
      type           VARCHAR(20)   NOT NULL,
      issuer         VARCHAR(512),
      authorize_url  VARCHAR(512),
      token_url      VARCHAR(512),
      userinfo_url   VARCHAR(512),
      email_url      VARCHAR(512),
      client_id      VARCHAR(255)  NOT NULL,
      client_secret  TEXT          NOT NULL,
      scope          VARCHAR(255)  NOT NULL DEFAULT 'openid email profile',
      field_id       VARCHAR(64)   NOT NULL DEFAULT 'sub',
      field_email    VARCHAR(64)   NOT NULL DEFAULT 'email',
      field_name     VARCHAR(64)   NOT NULL DEFAULT 'name',
      field_avatar   VARCHAR(64)   NOT NULL DEFAULT 'picture',
      icon           VARCHAR(32)   NOT NULL DEFAULT 'generic',
      enabled        TINYINT(1)    NOT NULL DEFAULT 1,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  client_upstream_permissions: `
    CREATE TABLE IF NOT EXISTS client_upstream_permissions (
      client_id    VARCHAR(100) NOT NULL,
      provider_id  VARCHAR(50)  NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (client_id, provider_id),
      CONSTRAINT fk_permission_client FOREIGN KEY (client_id) REFERENCES oidc_clients(client_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  identity_mappings: `
    CREATE TABLE IF NOT EXISTS identity_mappings (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      client_id         VARCHAR(100)  NOT NULL,
      provider          VARCHAR(50)   NOT NULL,
      provider_identity VARCHAR(190)  NOT NULL,
      target_identity   VARCHAR(190)  NOT NULL,
      display_name      VARCHAR(255),
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_mapping (client_id, provider, provider_identity, target_identity),
      KEY idx_mappings_lookup (client_id, provider, provider_identity),
      CONSTRAINT fk_mapping_client FOREIGN KEY (client_id) REFERENCES oidc_clients(client_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};
