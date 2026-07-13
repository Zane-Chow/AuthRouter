import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySessionStore } from '../src/session-store.js';

test('session store isolates values and expires them deterministically', () => {
  let now = 1000;
  const store = new MemorySessionStore({ now: () => now, cleanupIntervalMs: 60_000 });
  const session = { isAdmin: true, nested: { value: 1 } };
  store.set('session-1', session, 500);
  session.nested.value = 2;

  const loaded = store.get('session-1');
  assert.equal(loaded.nested.value, 1);
  loaded.nested.value = 3;
  assert.equal(store.get('session-1').nested.value, 1);

  now = 1501;
  assert.equal(store.get('session-1'), undefined);
  store.close();
});

test('session store destroys entries explicitly', () => {
  const store = new MemorySessionStore();
  store.set('session-1', { value: true }, 1000);
  store.destroy('session-1');
  assert.equal(store.get('session-1'), undefined);
  store.close();
});
