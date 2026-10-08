const test = require('node:test');
const assert = require('node:assert/strict');
const { content, prefix, image, standardHtml, script } = require('./helpers.cjs');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test('normal attachment uses a PNG File, verifies preview, focuses, and never sends by default', async t => {
  const env = content(); t.after(() => env.close());
  const result = await env.attach();
  assert.equal(result.ok, true);
  assert.equal(result.attached, true);
  assert.equal(result.sent, false);
  assert.equal(env.changes.length, 1);
  assert.equal(env.changes[0][0].type, 'image/png');
  assert.match(env.changes[0][0].name, /^screenshot-to-gpt-.*\.png$/);
  assert.ok(env.window.document.querySelector('[data-testid="attachment"]'));
  assert.equal(env.window.document.activeElement.id, 'prompt-textarea');
  assert.equal(env.clicks.length, 0);
});

test('composer and upload selectors fall back to the live accessible ChatGPT structure', async t => {
  const env = content({ html: `<main><form><div contenteditable="true" data-composer-markdown role="textbox" aria-label="Ask ChatGPT"></div><input type="file" accept="application/pdf" aria-label="Attach documents"><input type="file" accept="image/*" aria-label="Attach photos"><button type="button" aria-label="Send message">Send</button></form></main>` });
  t.after(() => env.close());
  assert.equal((await env.attach()).ok, true);
  const inputs = env.window.document.querySelectorAll('input');
  assert.equal(inputs[0].files.length, 0);
  assert.equal(inputs[1].files.length, 1);
  assert.equal(env.window.document.activeElement.getAttribute('aria-label'), 'Ask ChatGPT');
});

test('textarea fallback inserts the optional prompt without replacing a draft', async t => {
  const env = content({ html: `<main><form><textarea placeholder="Message ChatGPT">Existing draft</textarea><input type="file" accept="image/*"><button type="button" aria-label="Send">Send</button></form></main>` });
  t.after(() => env.close());
  assert.equal((await env.attach({ defaultPrompt: 'Explain this.', insertDefaultPrompt: true })).ok, true);
  assert.equal(env.window.document.querySelector('textarea').value, 'Existing draft\n\nExplain this.');
  assert.equal(env.clicks.length, 0);
});

test('default prompt is not inserted when its option is off', async t => {
  const env = content(); t.after(() => env.close());
  await env.attach({ defaultPrompt: 'Do not insert this.' });
  assert.equal(env.window.document.querySelector('#prompt-textarea').textContent, '');
});

test('contenteditable prompt insertion uses the native editing pipeline', async t => {
  const env = content(); t.after(() => env.close());
  const result = await env.attach({ defaultPrompt: 'Explain this image.', insertDefaultPrompt: true });
  assert.equal(result.ok, true);
  assert.equal(env.window.document.querySelector('#prompt-textarea').textContent, 'Explain this image.');
  assert.equal(env.clicks.length, 0);
});

test('unrelated conversation fails the final safety check before upload', async t => {
  const env = content({ url: 'https://chatgpt.com/c/unrelated-123' }); t.after(() => env.close());
  const result = await env.attach();
  assert.equal(result.code, 'TARGET_CHANGED');
  assert.equal(result.uploadStarted, false);
  assert.equal(env.changes.length, 0);
});

test('message fallback prevents an existing root conversation being treated as empty', async t => {
  const env = content({ html: standardHtml.replace('<main>', '<main><article aria-label="Assistant message">A reply</article>') });
  t.after(() => env.close());
  assert.equal((await env.inspect()).empty, false);
  assert.equal((await env.attach()).code, 'TARGET_CHANGED');
  assert.equal(env.changes.length, 0);
});

test('conversation URL is nonempty even when all message selectors disappear', async t => {
  const env = content({ url: 'https://chatgpt.com/c/existing-123' }); t.after(() => env.close());
  const state = await env.inspect();
  assert.equal(state.kind, 'conversation');
  assert.equal(state.empty, false);
});

test('Work mode is rejected using semantic mode controls', async t => {
  const env = content({ html: standardHtml.replace('<main>', '<button aria-label="Switch mode, current mode: Work">Work</button><main>') });
  t.after(() => env.close());
  assert.equal((await env.inspect()).workMode, true);
  assert.equal((await env.attach()).code, 'TARGET_CHANGED');
  assert.equal(env.changes.length, 0);
});

test('slow composer appears via MutationObserver and upload resumes', async t => {
  const env = content({ html: '<main></main>' }); t.after(() => env.close());
  setTimeout(() => { env.window.document.querySelector('main').innerHTML = standardHtml.match(/<form>[\s\S]*<\/form>/)[0]; }, 15);
  assert.equal((await env.attach()).ok, true);
  assert.equal(env.changes.length, 1);
});

test('attachment menu can lazily expose the file input', async t => {
  const env = content({ html: '<main><form><textarea placeholder="Ask ChatGPT"></textarea><button type="button" aria-label="Add files and more">+</button></form></main>' });
  t.after(() => env.close());
  env.window.document.querySelector('button').addEventListener('click', () => {
    const input = env.window.document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    env.window.document.querySelector('form').append(input);
  });
  assert.equal((await env.attach()).ok, true);
  assert.equal(env.changes.length, 1);
  assert.equal(env.clicks.length, 1);
});

test('missing or ambiguous upload inputs fail cleanly without launching a picker', async t => {
  const env = content({ html: '<main><form><textarea placeholder="Message ChatGPT"></textarea></form></main><input type="file" accept="image/*"><input type="file" accept="image/*">' });
  t.after(() => env.close());
  assert.equal((await env.attach()).code, 'UPLOAD_INPUT_MISSING');
  assert.equal(env.changes.length, 0);
  assert.equal(env.clicks.length, 0);
});

test('a new blob thumbnail proves attachment when test ids change', async t => {
  const env = content({ onUpload: (_event, window) => {
    const img = window.document.createElement('img'); img.src = 'blob:https://chatgpt.com/preview-123';
    window.document.querySelector('form').append(img);
  } });
  t.after(() => env.close());
  assert.equal((await env.attach()).ok, true);
});

test('an old attachment is not accepted as proof of a new upload', async t => {
  const env = content({ html: standardHtml.replace('</form>', '<div data-testid="attachment">old.png</div></form>'), onUpload: () => {} });
  t.after(() => env.close());
  const result = await env.attach();
  assert.equal(result.code, 'ATTACHMENT_TIMEOUT');
  assert.equal(result.uploadStarted, true);
  assert.equal(env.clicks.length, 0);
});

test('upload errors are surfaced and never send', async t => {
  const env = content({ onUpload: (_event, window) => {
    const alert = window.document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Upload limit reached'; window.document.body.append(alert);
  } });
  t.after(() => env.close());
  assert.equal((await env.attach({ autoSend: true })).code, 'UPLOAD_REJECTED');
  assert.equal(env.clicks.length, 0);
});

test('navigation while uploading does not trigger another assignment or send', async t => {
  const env = content({ onUpload: (_event, window) => { window.history.pushState({}, '', '/c/unrelated-123'); } });
  t.after(() => env.close());
  const result = await env.attach();
  assert.equal(result.code, 'TARGET_CHANGED');
  assert.equal(result.uploadStarted, true);
  assert.equal(env.changes.length, 1);
  assert.equal(env.clicks.length, 0);
});

test('duplicate delivery of one operation token attaches only once', async t => {
  const env = content(); t.after(() => env.close());
  const request = { type: prefix + 'attach', token: 'same-operation', dataUrl: image, expected: { kind: 'new', key: '/' }, settings: {} };
  const results = await Promise.all([env.dispatch(request), env.dispatch(request)]);
  assert.ok(results.every(result => result.ok));
  assert.equal(env.changes.length, 1);
});

test('a different concurrent operation is rejected as busy', async t => {
  const env = content({ onUpload: (_event, window) => {
    setTimeout(() => { const preview = window.document.createElement('img'); preview.src = 'blob:preview'; window.document.querySelector('form').append(preview); }, 15);
  } });
  t.after(() => env.close());
  const first = env.attach();
  assert.equal((await env.attach()).code, 'BUSY');
  assert.equal((await first).ok, true);
  assert.equal(env.changes.length, 1);
});

test('reinjecting content script does not register duplicate listeners', t => {
  const env = content(); t.after(() => env.close());
  env.window.eval(script('chatgpt-content.js'));
  assert.equal(env.onMessage.listeners.length, 1);
});

test('Auto-send explicitly enabled waits for a ready Send button', async t => {
  const env = content(); t.after(() => env.close());
  const button = env.window.document.querySelector('button'); button.disabled = true;
  setTimeout(() => { button.disabled = false; }, 15);
  const result = await env.attach({ autoSend: true });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(env.clicks.length, 1);
});

test('Auto-send waits until upload progress disappears', async t => {
  const env = content({ onUpload: (_event, window) => {
    const preview = window.document.createElement('div'); preview.dataset.testid = 'attachment';
    const progress = window.document.createElement('div'); progress.setAttribute('role', 'progressbar'); preview.append(progress);
    window.document.querySelector('form').append(preview);
    setTimeout(() => progress.remove(), 15);
  } });
  t.after(() => env.close());
  assert.equal((await env.attach({ autoSend: true })).sent, true);
  assert.equal(env.clicks.length, 1);
});

test('Auto-send is skipped for an existing draft', async t => {
  const env = content({ html: standardHtml.replace('<p><br></p>', '<p>Personal draft</p>') }); t.after(() => env.close());
  const result = await env.attach({ autoSend: true });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.match(result.warning, /draft/);
  assert.equal(env.clicks.length, 0);
});

test('Auto-send is skipped when the composer already contains an attachment', async t => {
  const env = content({ html: standardHtml.replace('</form>', '<div data-testid="attachment">previous.png</div></form>') });
  t.after(() => env.close());
  const result = await env.attach({ autoSend: true });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(env.clicks.length, 0);
});

test('initial Work mode in the new-chat toggle is detected before upload', async t => {
  const env = content({ html: standardHtml.replace('<main>', '<main><div role="group" aria-label="Composer mode"><button type="button" aria-pressed="false">Chat</button><button type="button" aria-pressed="true">Work</button></div>') });
  t.after(() => env.close());
  assert.equal((await env.inspect()).workMode, true);
  assert.equal((await env.attach()).uploadStarted, false);
});

test('a newly created empty Work tab can be switched to Chat without sending', async t => {
  const env = content({ html: standardHtml.replace('<main>', '<main><div role="group" aria-label="Composer mode"><button type="button" aria-pressed="false">Chat</button><button type="button" aria-pressed="true">Work</button></div>') });
  t.after(() => env.close());
  env.window.document.querySelector('button').addEventListener('click', () => {
    const buttons = env.window.document.querySelectorAll('[role="group"] button');
    buttons[0].setAttribute('aria-pressed', 'true'); buttons[1].setAttribute('aria-pressed', 'false');
  });
  assert.equal((await env.dispatch({ type: prefix + 'prepare-chat' })).ok, true);
  assert.equal((await env.inspect()).normalChat, true);
  assert.equal(env.changes.length, 0);
});

test('drafts typed during a slow upload are protected from Auto-send', async t => {
  const env = content({ onUpload: (event, window) => {
    window.document.querySelector('#prompt-textarea').textContent = 'A draft typed while uploading';
    const preview = window.document.createElement('div'); preview.dataset.testid = 'attachment';
    preview.textContent = event.target.files[0].name; window.document.querySelector('form').append(preview);
  } });
  t.after(() => env.close());
  const result = await env.attach({ autoSend: true });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(env.clicks.length, 0);
});

test('failed prompt insertion preserves the attachment and skips Auto-send', async t => {
  const env = content({ promptFailure: true }); t.after(() => env.close());
  const result = await env.attach({ autoSend: true, insertDefaultPrompt: true, defaultPrompt: 'Explain.' });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.match(result.warning, /prompt/);
  assert.equal(env.clicks.length, 0);
});

test('navigating to a sidebar conversation without submitting does not grant ownership', async t => {
  const env = content(); t.after(() => env.close());
  await env.attach();
  env.window.history.pushState({}, '', '/c/unrelated-123');
  env.window.document.querySelector('main').append(env.window.document.createElement('div'));
  await tick();
  assert.equal(env.outgoing.filter(message => message.type === prefix + 'conversation-created').length, 0);
  assert.equal((await env.inspect()).ownershipToken, null);
});

test('a new conversation produced by an opted-in send is reported for future reuse', async t => {
  const env = content(); t.after(() => env.close());
  env.window.document.querySelector('button').addEventListener('click', () => {
    env.window.history.pushState({}, '', '/c/created-conversation-123');
    env.window.document.querySelector('main').append(env.window.document.createElement('article'));
  });
  assert.equal((await env.attach({ autoSend: true })).sent, true);
  await tick();
  const notification = env.outgoing.find(message => message.type === prefix + 'conversation-created');
  assert.equal(notification.key, '/c/created-conversation-123');
});

test('invalid screenshot payload never reaches the input', async t => {
  const env = content(); t.after(() => env.close());
  assert.equal((await env.attach({}, { dataUrl: 'https://example.com/image.png' })).code, 'INVALID_SCREENSHOT');
  assert.equal(env.changes.length, 0);
});
