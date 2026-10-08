const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const script = name => fs.readFileSync(path.join(root, name), 'utf8');
const prefix = 'screenshot-to-gpt/';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });

function storage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, data[key]]));
      return { ...keys, ...data };
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
    async setAccessLevel() {}
  };
}

function worker(options = {}) {
  const source = { id: 1, windowId: 10, url: 'https://example.com/', active: true, incognito: false, ...options.source };
  const tabs = new Map([source, ...(options.tabs || [])].map(tab => [tab.id, { windowId: 10, incognito: false, ...tab }]));
  const calls = { captures: [], creates: [], attaches: [], focuses: [], probes: [], injections: [] };
  const sync = storage(options.settings);
  const local = storage({ knownConversations: options.known || [] });
  const session = storage(options.session);
  const onMessage = event();
  const onCommand = event();
  let nextId = 100;
  const api = {
    storage: { sync, local, session },
    runtime: { id: 'test-extension', onMessage, getURL: page => `chrome-extension://test-extension/${page}` },
    commands: { onCommand },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    windows: { async update(id) { calls.focuses.push(id); } },
    scripting: { async executeScript(details) { calls.injections.push(details); options.onInject?.(details); return []; } },
    tabs: {
      onRemoved: event(),
      async get(id) {
        options.onGet?.(tabs.get(id), calls);
        if (!tabs.has(id)) throw new Error(`No tab with id ${id}`);
        return { ...tabs.get(id) };
      },
      async query(query) {
        if (query.url) return Array.from(tabs.values()).filter(tab => tab.url.startsWith('https://chatgpt.com/')).map(tab => ({ ...tab }));
        return Array.from(tabs.values()).filter(tab => tab.active && (query.windowId == null || tab.windowId === query.windowId)).map(tab => ({ ...tab }));
      },
      async update(id, changes) {
        const tab = tabs.get(id);
        if (changes.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
        Object.assign(tab, changes, { discarded: false, frozen: false });
        return { ...tab };
      },
      async create(details) {
        calls.creates.push(details);
        const tab = { id: nextId++, windowId: details.windowId, url: details.url, incognito: source.incognito, ...options.newTab };
        tabs.set(tab.id, tab);
        await api.tabs.update(tab.id, { active: details.active });
        return { ...tab };
      },
      async captureVisibleTab(windowId, details) {
        calls.captures.push({ windowId, details, activeId: [...tabs.values()].find(tab => tab.active)?.id });
        if (options.captureError) throw new Error('Capture disallowed');
        if (options.captureGate) await options.captureGate;
        options.afterCapture?.(tabs);
        return image;
      },
      async sendMessage(id, message) {
        const tab = tabs.get(id);
        if (message.type === prefix + 'inspect') {
          calls.probes.push(id);
          if (options.noContent && !calls.injections.length) throw new Error('Receiving end does not exist');
          const route = context.ScreenshotToGPT.classifyChatUrl(tab.url);
          return options.state?.(tab, calls) || { ...route, ready: true, normalChat: route.kind !== 'other', empty: route.kind === 'new', ownershipToken: tab.ownershipToken || null };
        }
        if (message.type === prefix + 'attach') {
          calls.attaches.push({ id, message });
          return options.attach?.(tab, message, calls) || { ok: true, attached: true, sent: false };
        }
        if (message.type === prefix + 'prepare-chat') return options.prepare?.(tab) || { ok: false };
      }
    }
  };
  const start = Date.now();
  class FastDate extends Date { static now() { return start + (Date.now() - start) * 100; } }
  const context = vm.createContext({ chrome: api, crypto: { randomUUID }, URL, console, Date: FastDate,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 4)), clearTimeout });
  context.importScripts = name => vm.runInContext(script(name), context);
  vm.runInContext(script('background.js'), context);
  const dispatch = (message, sender = { id: api.runtime.id, url: api.runtime.getURL('popup.html') + '?capture=1' }) => new Promise(resolve => {
    const accepted = onMessage.listeners[0](message, sender, resolve);
    if (!accepted) resolve(undefined);
  });
  return { api, tabs, calls, context, dispatch, capture: () => dispatch({ type: prefix + 'capture', source: { id: source.id, windowId: source.windowId } }) };
}

const standardHtml = `<!doctype html><main><form>
  <div id="prompt-textarea" contenteditable="true" role="textbox"><p><br></p></div>
  <input type="file" accept="image/*" multiple aria-label="Attach photos">
  <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
</form></main>`;

function content(options = {}) {
  const dom = new JSDOM(options.html || standardHtml, { url: options.url || 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const onMessage = event();
  const outgoing = [];
  const changes = [];
  const clicks = [];
  const timers = new Set();
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (fn, ms) => {
    let id;
    id = nativeSetTimeout(() => { timers.delete(id); fn(); }, Math.min(ms, options.timerLimit || 120));
    timers.add(id);
    return id;
  };
  window.clearTimeout = id => { timers.delete(id); nativeClearTimeout(id); };
  window.HTMLElement.prototype.getClientRects = function () { return this.hidden || this.style.display === 'none' ? [] : [{ width: 100, height: 20 }]; };
  window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
    configurable: true,
    get() { return this._files || []; },
    set(files) { this._files = files; }
  });
  window.document.execCommand = (_command, _ui, value) => {
    if (options.promptFailure) return false;
    window.document.activeElement.textContent += value;
    window.document.activeElement.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
    return true;
  };
  window.chrome = { runtime: { id: 'test-extension', onMessage, async sendMessage(message) {
    outgoing.push(message);
    return options.trackFailure ? { ok: false } : { ok: true };
  } } };
  window.document.addEventListener('change', event => {
    if (event.target.type !== 'file') return;
    changes.push(event.target.files);
    if (options.onUpload) return options.onUpload(event, window);
    const preview = window.document.createElement('div');
    preview.dataset.testid = 'attachment';
    preview.textContent = event.target.files[0].name;
    window.document.querySelector('form').append(preview);
  });
  window.document.addEventListener('click', event => {
    if (event.target.closest('button')) clicks.push(event.target.closest('button'));
  });
  window.eval(script('shared.js'));
  window.eval(script('chatgpt-content.js'));
  const dispatch = message => new Promise(resolve => {
    const accepted = onMessage.listeners[0](message, { id: 'test-extension' }, resolve);
    if (!accepted && ![prefix + 'inspect', prefix + 'prepare-chat'].includes(message.type)) resolve(undefined);
  });
  const attach = (settings = {}, extras = {}) => dispatch({ type: prefix + 'attach', token: randomUUID(), dataUrl: image, expected: { kind: 'new', key: '/' }, settings, ...extras });
  return { dom, window, changes, clicks, outgoing, onMessage, dispatch, attach, inspect: () => dispatch({ type: prefix + 'inspect' }), close() { window.dispatchEvent(new window.Event('pagehide')); dom.window.close(); }, timers };
}

module.exports = { script, worker, content, prefix, image, standardHtml, storage };
