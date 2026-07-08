import { getOidcClient } from './clients.js';

/**
 * Custom oidc-provider Adapter (official extension point).
 *
 * - `Client` model: looked up live from the database on every `find()` call,
 *   so newly added/updated/removed downstream clients take effect immediately
 *   without restarting the process (fixes the old non-functional
 *   `reloadClients()` stub).
 * - All other models (Session, AccessToken, AuthorizationCode, RefreshToken,
 *   DeviceCode, Grant, Interaction, ReplayDetection,
 *   PushedAuthorizationRequest, BackchannelAuthenticationRequest, ...):
 *   kept as in-process memory storage, mirroring oidc-provider's own default
 *   in-memory behavior — these are inherently short-lived/session-scoped and
 *   don't need to survive a process restart.
 */

// model -> Map(id -> { payload, expiresAt })
const stores = new Map();
// Session.uid -> id
const uidIndex = new Map();
// DeviceCode userCode -> id
const userCodeIndex = new Map();
// grantId -> Set(`${model}:${id}`)
const grantIndex = new Map();

const GRANTABLE = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

function storeFor(model) {
  let store = stores.get(model);
  if (!store) {
    store = new Map();
    stores.set(model, store);
  }
  return store;
}

class MemoryAdapter {
  constructor(model) {
    this.model = model;
  }

  async upsert(id, payload, expiresIn) {
    const store = storeFor(this.model);
    const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;
    store.set(id, { payload, expiresAt });

    if (this.model === 'Session' && payload.uid) {
      uidIndex.set(payload.uid, id);
    }

    if (payload.userCode) {
      userCodeIndex.set(payload.userCode, id);
    }

    if (GRANTABLE.has(this.model) && payload.grantId) {
      const key = `${this.model}:${id}`;
      let set = grantIndex.get(payload.grantId);
      if (!set) {
        set = new Set();
        grantIndex.set(payload.grantId, set);
      }
      set.add(key);
    }
  }

  async find(id) {
    const store = storeFor(this.model);
    const entry = store.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      store.delete(id);
      return undefined;
    }
    return entry.payload;
  }

  async findByUserCode(userCode) {
    const id = userCodeIndex.get(userCode);
    if (!id) return undefined;
    return this.find(id);
  }

  async findByUid(uid) {
    const id = uidIndex.get(uid);
    if (!id) return undefined;
    return this.find(id);
  }

  async consume(id) {
    const store = storeFor(this.model);
    const entry = store.get(id);
    if (!entry) return;
    entry.payload.consumed = Math.floor(Date.now() / 1000);
  }

  async destroy(id) {
    const store = storeFor(this.model);
    store.delete(id);
  }

  async revokeByGrantId(grantId) {
    const set = grantIndex.get(grantId);
    if (!set) return;
    for (const key of set) {
      const [model, id] = key.split(/:(.+)/);
      storeFor(model).delete(id);
    }
    grantIndex.delete(grantId);
  }
}

class ClientAdapter {
  async upsert() {
    throw new Error('Dynamic client registration is not supported — manage clients via the /admin panel');
  }

  async find(id) {
    return getOidcClient(id);
  }

  async findByUserCode() {
    return undefined;
  }

  async findByUid() {
    return undefined;
  }

  async consume() {}

  async destroy() {}

  async revokeByGrantId() {}
}

export function DbAdapter(model) {
  if (model === 'Client') return new ClientAdapter();
  return new MemoryAdapter(model);
}
