"use strict";
const { DEFAULT_SETTINGS, MESSAGE_PREFIX, normalizeSettings } = ScreenshotToGPT;
const captureButton = document.getElementById('capture');
const promptInput = document.getElementById('default-prompt');
const insertInput = document.getElementById('insert-default-prompt');
const autoSendInput = document.getElementById('auto-send');
const statusElement = document.getElementById('status');
const settingsStatus = document.getElementById('settings-status');
let saving = Promise.resolve();
let promptSaveTimer;

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.dataset.error = String(isError);
}

function saveSettings() {
  clearTimeout(promptSaveTimer);
  promptSaveTimer = null;
  const settings = normalizeSettings({ defaultPrompt: promptInput.value, insertDefaultPrompt: insertInput.checked, autoSend: autoSendInput.checked });
  settingsStatus.textContent = 'Saving…';
  // Queue writes, so a slower earlier save cannot overwrite the newest toggle.
  saving = saving.catch(() => {}).then(() => chrome.storage.sync.set(settings));
  saving.then(() => { settingsStatus.textContent = 'Settings saved.'; }, () => { settingsStatus.textContent = 'Could not save settings. Check Chrome Sync storage and try again.'; });
}

async function capture() {
  if (captureButton.disabled) return;
  captureButton.disabled = true;
  showStatus('Capturing and attaching your screenshot…');
  try {
    if (promptSaveTimer) saveSettings();
    await saving;
    const [source] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const result = await chrome.runtime.sendMessage({ type: `${MESSAGE_PREFIX}capture`, source: source && { id: source.id, windowId: source.windowId } });
    showStatus(result?.message || 'The extension did not respond. Check ChatGPT before retrying.', !result?.ok);
  } catch {
    showStatus('Could not finish. Check the ChatGPT composer before retrying.', true);
  } finally { captureButton.disabled = false; }
}

captureButton.addEventListener('click', capture);
promptInput.addEventListener('input', () => {
  clearTimeout(promptSaveTimer);
  settingsStatus.textContent = 'Saving…';
  promptSaveTimer = setTimeout(saveSettings, 500);
});
promptInput.addEventListener('change', saveSettings);
window.addEventListener('pagehide', () => { if (promptSaveTimer) saveSettings(); });
insertInput.addEventListener('change', saveSettings);
autoSendInput.addEventListener('change', saveSettings);
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function initialize() {
  const autoCapture = new URLSearchParams(location.search).get('capture') === '1';
  if (!autoCapture) document.body.classList.add('options-page');
  captureButton.disabled = true;
  try {
    const settings = normalizeSettings(await chrome.storage.sync.get(DEFAULT_SETTINGS));
    promptInput.value = settings.defaultPrompt;
    insertInput.checked = settings.insertDefaultPrompt;
    autoSendInput.checked = settings.autoSend;
    const previous = await chrome.runtime.sendMessage({ type: `${MESSAGE_PREFIX}status` });
    if (previous?.lastResult) showStatus(previous.lastResult.message, previous.lastResult.phase === 'error');
    captureButton.disabled = false;
    // A toolbar click is an explicit capture action. The Options page omits this flag.
    if (autoCapture) await capture();
    else showStatus(previous?.lastResult?.message || 'Settings ready. Return to a webpage and use the icon or shortcut.', previous?.lastResult?.phase === 'error');
  } catch {
    captureButton.disabled = false;
    showStatus('Could not load settings. Reload the extension and try again.', true);
  }
}
void initialize();
