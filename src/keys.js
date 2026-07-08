import { generateKeyPair, exportJWK } from 'jose';
import fs from 'fs';
import path from 'path';
import config from './config.js';

const KEYS_PATH = path.join(config.dataDir, 'jwks.json');

/**
 * Get or generate JWKS (JSON Web Key Set) for signing OIDC tokens.
 * Keys are persisted to disk so they survive container restarts.
 * If existing tokens were issued with a key, rotating it would
 * invalidate those tokens — hence persistence matters.
 */
export async function getJWKS() {
  // Return existing keys if available
  if (fs.existsSync(KEYS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
      console.log('✅ Loaded existing JWKS keys');
      return data;
    } catch (err) {
      console.warn('⚠️  Failed to read existing JWKS, generating new keys:', err.message);
    }
  }

  // Generate a new RSA key pair for token signing
  console.log('🔑 Generating new RSA key pair for OIDC token signing...');
  const { privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(privateKey);

  // Add required metadata
  jwk.kid = `sso-key-${Date.now()}`;
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  const jwks = { keys: [jwk] };

  // Persist to disk
  const dataDir = config.dataDir;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(KEYS_PATH, JSON.stringify(jwks, null, 2), { mode: 0o600 });
  console.log(`✅ JWKS keys saved to ${KEYS_PATH}`);

  return jwks;
}
