(() => {
  "use strict";
  if (globalThis.__screenshotToGPTInstalled) return;
  globalThis.__screenshotToGPTInstalled = true;
  const { MESSAGE_PREFIX, classifyChatUrl, normalizeSettings } = ScreenshotToGPT;

  // Keep every site-dependent selector here. No generated CSS classes are used.
  const SELECTORS = Object.freeze({
    composer: [
      '#prompt-textarea',
      '[contenteditable="true"][data-composer-markdown]',
      '[role="textbox"][contenteditable="true"][aria-label*="ChatGPT" i]',
      'form [role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'form textarea',
      '[data-testid="composer"] [contenteditable="true"]'
    ],
    composerRoot: 'form, [data-testid="composer"], [data-type="unified-composer"]',
    fileInput: 'input[type="file"]',
    messages: [
      'main [data-message-author-role]', 'main [data-message-id]',
      'main [data-testid^="conversation-turn-"]', 'main article',
      'main [data-testid="user-message"]', 'main [data-testid="assistant-message"]',
      'main [data-turn-id]', 'main [data-testid="chatgpt-citation"]',
      'main [data-testid="chatgpt-writing-block"]'
    ].join(','),
    modeControls: 'button[aria-label^="Switch mode" i], [data-testid="mode-switcher"], [role="tab"][aria-selected="true"], [role="group"][aria-label="Composer mode"] button[aria-pressed="true"]',
    chatModeButtons: '[role="group"][aria-label="Composer mode"] button',
    workMarkers: '[data-testid="work-composer"], [data-testid="codex-composer"], [data-work-composer]',
    attachButton: [
      'button[aria-label="Add files and more" i]',
      'button[aria-label="Attach files" i]',
      'button[aria-label="Attach files and more" i]',
      'button[aria-label="Add photos and files" i]',
      'button[data-testid="composer-plus-btn"]'
    ],
    attachments: [
      '[data-testid="attachment"]', '[data-testid*="attachment-preview"]',
      '[data-testid^="file-upload"]', '[data-testid="file-preview"]',
      'img[src^="blob:"]', 'img[src^="data:image/"]',
      'button[aria-label*="Remove attachment" i]',
      'button[aria-label*="Remove file" i]', 'button[aria-label*="Remove image" i]',
      'button[aria-label*="Remove photo" i]'
    ].join(','),
    attachmentLabels: '[title], [aria-label], img[alt]',
    uploadBusy: '[role="progressbar"], [aria-busy="true"], [data-testid="upload-progress"]',
    errors: '[role="alert"], [data-testid="upload-error"]',
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt" i]',
      'button[aria-label="Send message" i]',
      'button[aria-label="Send" i]'
    ]
  });
  const operations = new Map();
  let attaching = false;
  let ownership = null;
  let stopWatchingOwnership = () => {};
  window.addEventListener('pagehide', () => { stopWatchingOwnership(); ownership = null; });

  function error(code, message) { return Object.assign(new Error(message), { code }); }
  function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function enabled(node) { return node && !node.disabled && node.getAttribute('aria-disabled') !== 'true'; }
  function visible(node) {
    return !!node && node.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  }
  function findFirst(selectors, root = document, predicate = visible) {
    for (const selector of selectors) {
      const found = Array.from(root.querySelectorAll(selector)).find(predicate);
      if (found) return found;
    }
    return null;
  }
  function composer() { return findFirst(SELECTORS.composer, document, node => visible(node) && enabled(node)); }
  function composerRoot(editor = composer()) { return editor?.closest(SELECTORS.composerRoot) || editor?.parentElement; }
  function text(editor) { return (editor?.tagName === 'TEXTAREA' ? editor.value : editor?.innerText || editor?.textContent || '').trim(); }

  function state() {
    const route = classifyChatUrl(location.href);
    const editor = composer();
    const controls = Array.from(document.querySelectorAll(SELECTORS.modeControls)).filter(visible);
    const workMode = !!document.querySelector(SELECTORS.workMarkers) || controls.some(node => {
      const label = node.getAttribute('aria-label') || '';
      const current = label.match(/current mode:\s*(.+)/i)?.[1] || node.textContent || '';
      return /\b(work|codex|agent|tasks?)\b/i.test(current);
    });
    const root = composerRoot(editor);
    const attachmentControl = root && findFirst(SELECTORS.attachButton, root);
    const loadingUploadControl = attachmentControl && !enabled(attachmentControl) && !findFileInput(root);
    const ready = !!editor && !!root && enabled(editor) && !loadingUploadControl;
    const normalChat = route.kind !== 'other' && !workMode;
    const empty = route.kind === 'new' && ready && normalChat && !document.querySelector(SELECTORS.messages);
    return { ...route, ready, normalChat, workMode, empty, ownershipToken: ownership?.key === route.key ? ownership.token : null };
  }

  function assertTarget(expected) {
    const current = state();
    if (!current.normalChat || current.kind !== expected.kind || current.key !== expected.key || (current.kind === 'new' && current.ready && !current.empty)) {
      throw error('TARGET_CHANGED', 'The selected chat changed. No screenshot was attached to that conversation.');
    }
    return current;
  }

  function prepareNewChat() {
    // Called only for the tab the worker just created. Do not switch an existing
    // conversation or click any Work action that could create or submit a task.
    if (classifyChatUrl(location.href).kind !== 'new' || document.querySelector(SELECTORS.messages)) return { ok: false };
    const button = Array.from(document.querySelectorAll(SELECTORS.chatModeButtons)).find(node =>
      visible(node) && (node.getAttribute('aria-label') || node.textContent).trim() === 'Chat');
    if (!button) return { ok: false };
    if (!enabled(button)) return { ok: false, retryable: true };
    button.click();
    return { ok: true };
  }

  // Every observer and interval below has a timeout and is disconnected on success/failure.
  function waitFor(check, timeout, code, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      let timer;
      let interval;
      const finish = (value, failure) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        clearTimeout(timer);
        clearInterval(interval);
        failure ? reject(failure) : resolve(value);
      };
      const inspect = () => {
        if (settled) return;
        try { const value = check(); if (value) finish(value); }
        catch (failure) { finish(null, failure); }
      };
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      timer = setTimeout(() => finish(null, error(code, message)), timeout);
      interval = setInterval(inspect, 250);
      inspect();
    });
  }

  function findFileInput(root) {
    const acceptsPng = input => {
      if (!enabled(input)) return false;
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      return !accept || accept.split(',').some(type => ['image/*', 'image/png', '.png', '*/*'].includes(type.trim()));
    };
    const preferred = inputs => inputs.sort((a, b) => {
      const score = input => Number(/image/i.test(input.getAttribute('accept') || '')) * 2 + Number(/photos|image/i.test(input.getAttribute('aria-label') || ''));
      return score(b) - score(a);
    })[0] || null;
    const local = Array.from(root.querySelectorAll(SELECTORS.fileInput)).filter(acceptsPng);
    if (local.length) return preferred(local);
    // A global fallback is safe only when it is unambiguous; avoid avatar/settings uploads.
    const global = Array.from(document.querySelectorAll(SELECTORS.fileInput)).filter(acceptsPng);
    return global.length === 1 ? global[0] : null;
  }

  function attachmentSnapshot(root) {
    return new Map(Array.from(root.querySelectorAll(SELECTORS.attachments)).filter(visible).map(node => [node,
      [node.getAttribute('src'), node.getAttribute('title'), node.getAttribute('aria-label'), node.textContent].join('|')]));
  }

  function attachmentAppeared(root, filename, baseline) {
    const named = Array.from(root.querySelectorAll(SELECTORS.attachmentLabels)).some(node => visible(node) &&
      ['title', 'aria-label', 'alt'].some(attribute => node.getAttribute(attribute)?.includes(filename)));
    // An exact filename rendered in the composer also proves that a new preview exists.
    if (named || root.textContent?.includes(filename)) return true;
    for (const [node, fingerprint] of attachmentSnapshot(root)) {
      if (!baseline.has(node) || baseline.get(node) !== fingerprint) return true;
    }
    return false;
  }

  function screenshotFile(dataUrl, token) {
    const prefix = 'data:image/png;base64,';
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length > 48 * 1024 * 1024) {
      throw error('INVALID_SCREENSHOT', 'The screenshot is invalid or too large to attach.');
    }
    let bytes;
    try { bytes = Uint8Array.from(atob(dataUrl.slice(prefix.length)), character => character.charCodeAt(0)); }
    catch { throw error('INVALID_SCREENSHOT', 'Chrome returned an invalid screenshot. Try again.'); }
    if (!bytes.length) throw error('INVALID_SCREENSHOT', 'The screenshot is empty. Try again.');
    const filename = `screenshot-to-gpt-${new Date().toISOString().replace(/[:.]/g, '-')}-${token.slice(0, 8)}.png`;
    const blob = new Blob([bytes], { type: 'image/png' });
    return new File([blob], filename, { type: 'image/png', lastModified: Date.now() });
  }

  function notify(message, isError = false) {
    const previous = document.getElementById('screenshot-to-gpt-notice');
    previous?.remove();
    const notice = document.createElement('div');
    notice.id = 'screenshot-to-gpt-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.textContent = `Screenshot to GPT: ${message}`;
    Object.assign(notice.style, {
      position: 'fixed', bottom: '24px', right: '24px', maxWidth: '380px', padding: '14px 18px',
      borderRadius: '12px', color: '#fff', background: isError ? '#912018' : '#176b50',
      boxShadow: '0 6px 28px #0003', zIndex: '2147483647', font: '14px/1.5 system-ui', pointerEvents: 'none'
    });
    document.body?.append(notice);
    setTimeout(() => notice.remove(), 8000);
  }

  function focus(editor) {
    editor.focus({ preventScroll: true });
    if (editor.tagName === 'TEXTAREA') editor.setSelectionRange(editor.value.length, editor.value.length);
    else {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function insertPrompt(editor, prompt) {
    focus(editor);
    const addition = text(editor) ? `\n\n${prompt}` : prompt;
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, editor.value + addition);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: addition }));
    } else {
      // execCommand is retained by Chrome for editing contenteditable text; it updates
      // ProseMirror/React through the native editing pipeline and preserves the draft.
      const inserted = document.execCommand('insertText', false, addition);
      if (!inserted) throw error('PROMPT_FAILED', 'The screenshot is attached, but the default prompt could not be inserted. Type it manually.');
    }
    focus(editor);
  }

  function armOwnership(token, expected) {
    stopWatchingOwnership();
    ownership = { token, key: expected.key };
    if (expected.kind !== 'new') return;
    let sendingAt = 0;
    let finished = false;
    let expiry;
    let observer;
    const stop = () => {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      clearTimeout(expiry);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('submit', onSubmit, true);
      window.removeEventListener('popstate', onRoute);
    };
    const markSending = () => {
      if (state().kind !== 'new' || !state().empty) return;
      sendingAt = Date.now();
      // Stay passive while the screenshot is a draft. Observe route creation only
      // after an explicit send, including when the user sends much later.
      observer?.disconnect();
      clearTimeout(expiry);
      observer = new MutationObserver(onRoute);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      expiry = setTimeout(() => { observer.disconnect(); sendingAt = 0; }, 120_000);
    };
    const onClick = event => {
      if (event.isTrusted && event.target.closest(SELECTORS.send.join(','))?.closest(SELECTORS.composerRoot) === composerRoot()) markSending();
    };
    const onKey = event => {
      const editor = composer();
      if (event.isTrusted && event.key === 'Enter' && !event.shiftKey && !event.isComposing && editor?.contains(event.target)) markSending();
    };
    const onSubmit = event => { if (event.isTrusted && event.target === composerRoot()) markSending(); };
    const onRoute = () => {
      const route = classifyChatUrl(location.href);
      if (route.key === '/') return;
      if (route.kind === 'conversation' && sendingAt && Date.now() - sendingAt < 120_000) {
        ownership.key = route.key;
        void chrome.runtime.sendMessage({ type: `${MESSAGE_PREFIX}conversation-created`, token, key: route.key }).catch(() => {});
      } else ownership = null; // Clicking an unrelated sidebar chat never grants ownership.
      stop();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('popstate', onRoute);
    stopWatchingOwnership = stop;
    return markSending;
  }

  async function attach(message) {
    if (attaching) return { ok: false, code: 'BUSY', uploadStarted: false, message: 'An attachment is already in progress.' };
    attaching = true;
    let uploadStarted = false;
    let attached = false;
    const heartbeat = setInterval(() => {
      void chrome.runtime.sendMessage({ type: `${MESSAGE_PREFIX}heartbeat`, token: message.token }).catch(() => {});
    }, 10_000);
    try {
      const settings = normalizeSettings(message.settings);
      const file = screenshotFile(message.dataUrl, message.token);
      await waitFor(() => composer(), 15_000, 'COMPOSER_TIMEOUT', 'The ChatGPT composer did not load. Sign in and try again.');
      assertTarget(message.expected);
      const initialEditor = composer();
      let hadDraft = !!text(initialEditor) || attachmentSnapshot(composerRoot(initialEditor)).size > 0;
      let root = composerRoot(initialEditor);
      let input = findFileInput(root);
      if (!input) {
        // Only open the attachment menu. Never click a file input or launch a picker.
        const button = findFirst(SELECTORS.attachButton, root, node => visible(node) && enabled(node));
        if (button) button.click();
        input = await waitFor(() => {
          assertTarget(message.expected);
          root = composerRoot();
          return root && findFileInput(root);
        }, 5000, 'UPLOAD_INPUT_MISSING', 'ChatGPT’s image upload input was not found. The page may have changed, or uploads may be unavailable for this account.');
      }
      assertTarget(message.expected);
      root = composerRoot();
      const baseline = attachmentSnapshot(root);
      const priorErrors = new Set(Array.from(document.querySelectorAll(SELECTORS.errors)).map(node => node.textContent));
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      uploadStarted = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => {
        assertTarget(message.expected);
        const uploadError = Array.from(document.querySelectorAll(SELECTORS.errors)).find(node => visible(node) && !priorErrors.has(node.textContent) && /upload|file|image|limit|large|failed|error/i.test(node.textContent));
        if (uploadError) throw error('UPLOAD_REJECTED', 'ChatGPT reported an upload problem. Check its upload limit and the composer before retrying.');
        root = composerRoot();
        return root && attachmentAppeared(root, file.name, baseline);
      }, 45_000, 'ATTACHMENT_TIMEOUT', 'The upload was initiated, but no new attachment preview could be verified. Check the composer before retrying to avoid a duplicate.');
      attached = true;
      hadDraft ||= !!text(composer()); // Also protect a draft typed while the upload was pending.
      let warning = '';
      let markSending;
      const tracked = await chrome.runtime.sendMessage({ type: `${MESSAGE_PREFIX}attachment-confirmed`, token: message.token }).catch(() => null);
      if (tracked?.ok) markSending = armOwnership(message.token, message.expected);
      else warning = 'Screenshot attached, but conversation tracking could not be saved. Check extension storage before the next capture.';
      const editor = composer();
      if (settings.insertDefaultPrompt && settings.defaultPrompt.trim()) {
        try { insertPrompt(editor, settings.defaultPrompt); }
        catch (failure) { warning = failure.message; }
      }
      focus(composer());
      const preparedText = text(composer());
      let sent = false;
      if (settings.autoSend) {
        if (hadDraft) warning = 'Screenshot attached. Auto-send was skipped because this composer already contained a draft.';
        else if (!tracked?.ok || warning) warning ||= 'Screenshot attached. Auto-send was skipped because tracking could not be saved.';
        else {
          try {
            const button = await waitFor(() => {
              assertTarget(message.expected);
              const currentRoot = composerRoot();
              if (!currentRoot) return null;
              if (text(composer()) !== preparedText) throw error('DRAFT_CHANGED', 'Screenshot attached. Auto-send was skipped because the draft changed during upload.');
              if (!attachmentAppeared(currentRoot, file.name, baseline)) throw error('ATTACHMENT_REMOVED', 'The attachment was removed. Auto-send was skipped.');
              if (Array.from(currentRoot.querySelectorAll(SELECTORS.uploadBusy)).some(visible)) return null;
              return findFirst(SELECTORS.send, currentRoot, node => visible(node) && enabled(node));
            }, 20_000, 'SEND_NOT_READY', 'Screenshot attached. Auto-send was skipped because ChatGPT’s Send button did not become ready.');
            markSending?.();
            button.click(); // The only Send action; guarded by the explicitly enabled setting.
            sent = true;
          } catch (failure) { warning = failure.message; }
        }
      }
      const messageText = warning || (sent ? 'Screenshot sent (Auto-send enabled).' : 'Screenshot attached. Review it before sending.');
      notify(messageText);
      return { ok: true, attached: true, sent, warning };
    } catch (failure) {
      const messageText = uploadStarted && failure.code === 'TARGET_CHANGED'
        ? 'The chat changed while the screenshot was uploading. Check the previous composer before retrying.'
        : failure.message || 'Could not attach the screenshot. Check ChatGPT before retrying.';
      notify(messageText, true);
      return { ok: false, code: failure.code || 'ATTACH_FAILED', message: messageText, uploadStarted, attached };
    } finally {
      clearInterval(heartbeat);
      attaching = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === `${MESSAGE_PREFIX}inspect`) { sendResponse(state()); return false; }
    if (message?.type === `${MESSAGE_PREFIX}prepare-chat`) { sendResponse(prepareNewChat()); return false; }
    if (message?.type !== `${MESSAGE_PREFIX}attach` || typeof message.token !== 'string' || !message.expected) return false;
    if (!operations.has(message.token)) {
      if (operations.size >= 20) operations.delete(operations.keys().next().value);
      operations.set(message.token, attach(message));
    }
    operations.get(message.token).then(sendResponse, () => sendResponse({ ok: false, uploadStarted: true, message: 'Check the ChatGPT composer before retrying.' }));
    return true;
  });
})();
