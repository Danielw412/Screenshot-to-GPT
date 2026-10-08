const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { script, storage, prefix } = require('./helpers.cjs');

function popup(search = '', settings = {}) {
  const dom = new JSDOM(script('popup.html'), { url: `chrome-extension://test-extension/popup.html${search}`, runScripts: 'outside-only' });
  const outgoing = [];
  const sync = storage(settings);
  dom.window.chrome = {
    storage: { sync }, tabs: { async query() { return [{ id: 1, windowId: 10 }]; } },
    runtime: { async sendMessage(message) { outgoing.push(message); return message.type === prefix + 'capture' ? { ok: true, message: 'Screenshot attached.' } : {}; }, async openOptionsPage() {} }
  };
  dom.window.eval(script('shared.js'));
  dom.window.eval(script('popup.js'));
  return { dom, sync, outgoing, document: dom.window.document, tick: () => new Promise(resolve => setTimeout(resolve, 10)), close() { dom.window.close(); } };
}

test('opening Options does not capture; both settings default to off', async t => {
  const env = popup(); t.after(() => env.close()); await env.tick();
  assert.equal(env.outgoing.filter(message => message.type === prefix + 'capture').length, 0);
  assert.equal(env.document.querySelector('#insert-default-prompt').checked, false);
  assert.equal(env.document.querySelector('#auto-send').checked, false);
});

test('toolbar popup captures exactly once and button supports another explicit capture', async t => {
  const env = popup('?capture=1'); t.after(() => env.close()); await env.tick();
  assert.equal(env.outgoing.filter(message => message.type === prefix + 'capture').length, 1);
  env.document.querySelector('#capture').click(); await env.tick();
  assert.equal(env.outgoing.filter(message => message.type === prefix + 'capture').length, 2);
});

test('settings save and a pending prompt edit is flushed before capture', async t => {
  const env = popup(); t.after(() => env.close()); await env.tick();
  const prompt = env.document.querySelector('#default-prompt'); prompt.value = 'Explain this screenshot.';
  prompt.dispatchEvent(new env.dom.window.Event('input', { bubbles: true }));
  assert.equal(env.sync.data.defaultPrompt, undefined);
  const insert = env.document.querySelector('#insert-default-prompt'); insert.checked = true;
  insert.dispatchEvent(new env.dom.window.Event('change', { bubbles: true }));
  env.document.querySelector('#capture').click(); await env.tick();
  assert.equal(env.sync.data.defaultPrompt, 'Explain this screenshot.');
  assert.equal(env.sync.data.insertDefaultPrompt, true);
  assert.equal(env.sync.data.autoSend, false);
});
