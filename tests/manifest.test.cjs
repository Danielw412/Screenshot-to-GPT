const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { script } = require('./helpers.cjs');
const root = path.resolve(__dirname, '..');

test('manifest uses MV3 with only the requested permissions and packaged files', () => {
  const manifest = JSON.parse(script('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.equal(manifest.commands['capture-screenshot'].suggested_key.default, 'Alt+Shift+A');
  const files = [manifest.background.service_worker, manifest.action.default_popup.split('?')[0], manifest.options_ui.page,
    ...Object.values(manifest.icons), ...manifest.content_scripts[0].js];
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
  for (const [size, file] of Object.entries(manifest.icons)) {
    const bytes = fs.readFileSync(path.join(root, file));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), Number(size));
    assert.equal(bytes.readUInt32BE(20), Number(size));
  }
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.ok(!script('popup.html').match(/<script[^>]*>[^<\s]/));
});

test('settings default to off and reject truthy non-boolean values', () => {
  const context = vm.createContext({ URL }); vm.runInContext(script('shared.js'), context);
  const shared = context.ScreenshotToGPT;
  assert.equal(shared.DEFAULT_SETTINGS.autoSend, false);
  assert.equal(shared.DEFAULT_SETTINGS.insertDefaultPrompt, false);
  const settings = shared.normalizeSettings({ autoSend: 'true', insertDefaultPrompt: 1, defaultPrompt: 'x'.repeat(3000) });
  assert.equal(settings.autoSend, false);
  assert.equal(settings.insertDefaultPrompt, false);
  assert.equal(settings.defaultPrompt.length, 2000);
});

test('URL classification excludes lookalike hosts, Work, tasks, and unsupported routes', () => {
  const context = vm.createContext({ URL }); vm.runInContext(script('shared.js'), context);
  const classify = context.ScreenshotToGPT.classifyChatUrl;
  for (const url of ['https://chatgpt.com.evil.test/', 'http://chatgpt.com/', 'https://chatgpt.com/work', 'https://chatgpt.com/?mode=work', 'https://chatgpt.com/tasks', 'https://chatgpt.com/auth/login']) {
    assert.equal(classify(url).kind, 'other');
  }
  assert.equal(classify('https://chatgpt.com/c/conversation-123?model=auto').key, '/c/conversation-123');
  assert.equal(classify('https://chatgpt.com/g/g-p-project-123/c/conversation-123').key, '/c/conversation-123');
  assert.equal(classify('https://chatgpt.com/').kind, 'new');
});
