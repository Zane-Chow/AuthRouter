import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from './config.js';

/**
 * Symmetric encryption for secrets stored at rest (downstream client_secret,
 * upstream IdP client_secret). Reversible by design: oidc-provider's built-in
 * client_secret_basic/post verification needs the plaintext, and upstream IdP
 * secrets must be sent as plaintext to the IdP's token endpoint — so one-way
 * hashing is not viable here.
 */

const KEY_PATH = path.join(config.dataDir, 'encryption.key');
const PREFIX = 'v1:';

let cachedKey = null;

function loadOrCreateKey() {
  if (cachedKey) return cachedKey;

  if (process.env.ENCRYPTION_KEY) {
    const raw = process.env.ENCRYPTION_KEY.trim();
    const key = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)');
    }
    cachedKey = key;
    return cachedKey;
  }

  if (fs.existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_PATH, 'utf-8').trim(), 'base64');
    if (cachedKey.length !== 32) throw new Error(`Invalid encryption key at ${KEY_PATH}`);
    return cachedKey;
  }

  console.log('🔑 Generating new secret-encryption key...');
  const key = crypto.randomBytes(32);

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  const temporaryPath = `${KEY_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, key.toString('base64'), { mode: 0o600 });
  fs.renameSync(temporaryPath, KEY_PATH);
  console.log(`✅ Encryption key saved to ${KEY_PATH}`);

  cachedKey = key;
  return cachedKey;
}

/**
 * Encrypt a plaintext secret for storage.
 * @param {string} plaintext
 * @returns {string} `v1:<iv>:<authTag>:<ciphertext>` (all base64)
 */
export function encryptSecret(plaintext) {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a stored secret. Values not produced by encryptSecret (legacy
 * plaintext rows from before this feature existed) are returned unchanged.
 * @param {string} stored
 * @returns {string} plaintext
 */
export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) {
    // Legacy plaintext — return as-is.
    return stored;
  }

  const key = loadOrCreateKey();
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString('utf-8');
}

/**
 * True if the stored value is already encrypted (vs. legacy plaintext).
 * @param {string} stored
 */
export function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}
