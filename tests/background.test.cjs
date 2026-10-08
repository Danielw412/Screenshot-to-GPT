const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, prefix } = require('./helpers.cjs');
const conversation = 'https://chatgpt.com/c/conversation-123';

test('no ChatGPT tab: capture first, create plain root URL, then attach', async () => {
  const env = worker();
  const result = await env.capture();
  assert.equal(result.ok, true);
  assert.equal(env.calls.captures[0].activeId, 1);
  assert.equal(env.calls.creates.length, 1);
  assert.equal(env.calls.creates[0].url, 'https://chatgpt.com/');
  assert.equal(env.calls.attaches[0].id, 100);
  assert.equal(env.calls.attaches[0].message.settings.autoSend, false);
  assert.equal(env.calls.attaches[0].message.settings.insertDefaultPrompt, false);
  assert.ok(!JSON.stringify(env.api.storage).includes('data:image'));
});

test('empty ChatGPT tab is reused', async () => {
  const env = worker({ tabs: [{ id: 2, url: 'https://chatgpt.com/' }] });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.creates.length, 0);
  assert.equal(env.calls.attaches[0].id, 2);
});

test('unrelated existing conversation is never injected or modified', async () => {
  const env = worker({ source: { url: conversation } });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.creates.length, 1);
  assert.ok(!env.calls.probes.includes(1));
  assert.ok(!env.calls.injections.some(call => call.target.tabId === 1));
  assert.equal(env.calls.attaches[0].id, 100);
});

test('known conversation wins over empty tabs, even in a different window', async () => {
  const env = worker({ known: [{ key: '/c/conversation-123', usedAt: 1 }], tabs: [{ id: 2, url: 'https://chatgpt.com/' }, { id: 3, url: conversation, windowId: 20 }] });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.attaches[0].id, 3);
  assert.equal(env.calls.creates.length, 0);
  assert.deepEqual(env.calls.focuses, [20]);
});

test('a formerly used tab navigated to another conversation does not inherit ownership', async () => {
  const env = worker({ tabs: [{ id: 2, url: 'https://chatgpt.com/c/unrelated-123' }], session: { bindings: { 2: { confirmed: true, key: '/c/conversation-123', token: 'old' } } } });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.attaches[0].id, 100);
});

test('a root tab with rendered messages is not considered empty', async () => {
  const env = worker({ tabs: [{ id: 2, url: 'https://chatgpt.com/' }], state: tab => ({ kind: 'new', key: '/', ready: true, normalChat: true, empty: tab.id !== 2 }) });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.attaches[0].id, 100);
});

test('slow ChatGPT readiness is retried with a bound', async () => {
  const env = worker({ state: (tab, calls) => ({ kind: 'new', key: '/', empty: true, normalChat: true, ready: calls.probes.length > 3 }) });
  assert.equal((await env.capture()).ok, true);
  assert.ok(env.calls.probes.length >= 4);
  assert.equal(env.calls.attaches.length, 1);
});

test('a tab that never loads times out without uploading and releases the lock', async () => {
  const env = worker({ state: () => ({ kind: 'new', key: '/', ready: false, normalChat: true }) });
  const result = await env.capture();
  assert.equal(result.code, 'CHATGPT_TIMEOUT');
  assert.equal(env.calls.attaches.length, 0);
  assert.equal(env.api.storage.session.data.busy, undefined);
});

test('already-open tabs get idempotent content injection after installation', async () => {
  const env = worker({ noContent: true, tabs: [{ id: 2, url: 'https://chatgpt.com/' }] });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.injections.length, 1);
});

test('rapid repeated requests capture and attach only once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = worker({ captureGate: gate });
  const first = env.capture();
  const repeated = await Promise.all([env.capture(), env.capture(), env.capture()]);
  assert.ok(repeated.every(result => result.code === 'BUSY'));
  release();
  assert.equal((await first).ok, true);
  assert.equal(env.calls.captures.length, 1);
  assert.equal(env.calls.attaches.length, 1);
});

test('persistent session lock survives service worker restart', async () => {
  const env = worker({ session: { busy: { expiresAt: Date.now() + 60_000 } } });
  assert.equal((await env.capture()).code, 'BUSY');
  assert.equal(env.calls.captures.length, 0);
});

test('restricted source pages fail cleanly without creating a destination', async () => {
  const env = worker({ source: { url: 'chrome://extensions/' } });
  assert.equal((await env.capture()).code, 'RESTRICTED_PAGE');
  assert.equal(env.calls.captures.length, 0);
  assert.equal(env.calls.creates.length, 0);
});

test('capture rejection is reported without uploading', async () => {
  const env = worker({ captureError: true });
  assert.equal((await env.capture()).code, 'CAPTURE_FAILED');
  assert.equal(env.calls.creates.length, 0);
});

test('source-tab switch during capture discards the screenshot', async () => {
  const env = worker({ tabs: [{ id: 2, url: 'https://example.net/' }], afterCapture: tabs => { tabs.get(1).active = false; tabs.get(2).active = true; } });
  assert.equal((await env.capture()).code, 'SOURCE_CHANGED');
  assert.equal(env.calls.attaches.length, 0);
});

test('Work mode is excluded, even in a previously used conversation', async () => {
  const env = worker({ known: [{ key: '/c/conversation-123' }], tabs: [{ id: 2, url: conversation }], state: tab => tab.id === 2 ? { kind: 'conversation', key: '/c/conversation-123', ready: true, normalChat: false, workMode: true } : null });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.attaches[0].id, 100);
});

test('new root opening in Work mode fails without uploading', async () => {
  const env = worker({ state: () => ({ kind: 'new', key: '/', ready: true, normalChat: false, workMode: true }) });
  assert.equal((await env.capture()).code, 'CHAT_MODE_REQUIRED');
  assert.equal(env.calls.attaches.length, 0);
});

test('new root tab switches its empty composer to Chat when the semantic toggle is available', async () => {
  let workMode = true;
  const env = worker({ state: () => ({ kind: 'new', key: '/', empty: true, ready: true, normalChat: !workMode, workMode }), prepare: () => { workMode = false; return { ok: true }; } });
  assert.equal((await env.capture()).ok, true);
  assert.equal(workMode, false);
  assert.equal(env.calls.attaches.length, 1);
});

test('navigation detected before file assignment retries safely in a new tab', async () => {
  const env = worker({ tabs: [{ id: 2, url: 'https://chatgpt.com/' }], attach: (_tab, _message, calls) => calls.attaches.length === 1 ? { ok: false, code: 'TARGET_CHANGED', uploadStarted: false } : { ok: true, attached: true, sent: false } });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.attaches.length, 2);
  assert.equal(env.calls.creates.length, 1);
});

test('an uncertain attachment failure is never resent', async () => {
  const env = worker({ attach: () => ({ ok: false, code: 'ATTACHMENT_TIMEOUT', uploadStarted: true, message: 'Check the composer.' }) });
  assert.equal((await env.capture()).code, 'ATTACHMENT_TIMEOUT');
  assert.equal(env.calls.attaches.length, 1);
});

test('content-script messages cannot trigger captures', async () => {
  const env = worker();
  const result = await env.dispatch({ type: prefix + 'capture' }, { id: 'test-extension', tab: { id: 2 }, url: 'https://chatgpt.com/', frameId: 0 });
  assert.equal(result, undefined);
  assert.equal(env.calls.captures.length, 0);
});

test('confirmed root transitions are persisted only for the same token and document', async () => {
  const env = worker({ tabs: [{ id: 2, url: 'https://chatgpt.com/', ownershipToken: 'owned' }], session: { bindings: { 2: { token: 'owned', key: '/', confirmed: false } } } });
  const sender = { id: 'test-extension', tab: { id: 2 }, frameId: 0, documentId: 'doc-1', url: 'https://chatgpt.com/' };
  assert.equal((await env.dispatch({ type: prefix + 'attachment-confirmed', token: 'owned' }, sender)).ok, true);
  env.tabs.get(2).url = conversation;
  assert.equal((await env.dispatch({ type: prefix + 'conversation-created', token: 'owned', key: '/c/conversation-123' }, { ...sender, documentId: 'doc-other' })).ok, false);
  assert.equal((await env.dispatch({ type: prefix + 'conversation-created', token: 'owned', key: '/c/conversation-123' }, sender)).ok, true);
  assert.equal(env.api.storage.local.data.knownConversations[0].key, '/c/conversation-123');
});

test('incognito and regular tabs are not mixed', async () => {
  const env = worker({ source: { incognito: true }, tabs: [{ id: 2, url: 'https://chatgpt.com/', incognito: false }] });
  assert.equal((await env.capture()).ok, true);
  assert.equal(env.calls.attaches[0].id, 100);
});
