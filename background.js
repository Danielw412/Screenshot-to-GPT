"use strict";
importScripts("shared.js");

const { DEFAULT_SETTINGS, MESSAGE_PREFIX, normalizeSettings, classifyChatUrl, eligibility } = ScreenshotToGPT;
const OPERATION_TIMEOUT = 150_000;
const LOCK_TIMEOUT = OPERATION_TIMEOUT + 15_000;
let inFlight = false;
let trackingWrites = Promise.resolve();

// This runs on worker startup; it neither captures nor keeps the worker awake.
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
]);
storageReady.catch(() => {});

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function status(phase, message, code = null) {
  const result = { phase, message, code, at: Date.now() };
  await chrome.storage.session.set({ lastResult: result });
  await Promise.all([
    chrome.action.setBadgeText({ text: phase === "working" ? "…" : phase === "error" ? "!" : "OK" }),
    chrome.action.setBadgeBackgroundColor({ color: phase === "error" ? "#b42318" : "#176b50" }),
    chrome.action.setTitle({ title: `Screenshot to GPT — ${message}` })
  ]);
  return result;
}

function safeStatus(...args) { return status(...args).catch(() => null); }

async function inspect(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (classifyChatUrl(tab.url).kind === "other" || tab.discarded || tab.frozen) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: `${MESSAGE_PREFIX}inspect` }, { frameId: 0 });
  } catch {
    // Covers already-open tabs after the extension is installed or reloaded.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "chatgpt-content.js"] });
    return chrome.tabs.sendMessage(tabId, { type: `${MESSAGE_PREFIX}inspect` }, { frameId: 0 });
  }
}

async function waitForReady(tabId, deadline, prepareNewChat = false) {
  let lastError;
  let preparedMode = false;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && classifyChatUrl(tab.url).kind === "other") {
        throw failure("CHAT_MODE_REQUIRED", "Open a normal ChatGPT Chat and sign in, then try again. Work pages are not supported.");
      }
      const state = await inspect(tabId);
      if (state?.ready && state.normalChat) {
        if (state.kind !== "new") return state;
        // Avoid interpreting a briefly empty DOM during SPA hydration as a new chat.
        await pause(300);
        const stable = await inspect(tabId);
        if (stable?.ready && stable.normalChat && stable.kind === state.kind && stable.key === state.key) return stable;
      }
      if (state?.workMode) {
        if (prepareNewChat && state.kind === "new") {
          if (!preparedMode) {
            const prepared = await chrome.tabs.sendMessage(tabId, { type: `${MESSAGE_PREFIX}prepare-chat` }, { frameId: 0 });
            if (prepared?.ok) preparedMode = true;
            else if (!prepared?.retryable) throw failure("CHAT_MODE_REQUIRED", "Switch ChatGPT to Chat mode, then try again. Screenshot to GPT does not attach to Work mode.");
          }
        } else {
          throw failure("CHAT_MODE_REQUIRED", "Switch ChatGPT to Chat mode, then try again. Screenshot to GPT does not attach to Work mode.");
        }
      }
    } catch (error) {
      if (error.code === "CHAT_MODE_REQUIRED" || /No tab with id/i.test(error.message)) throw error;
      lastError = error;
    }
    // Every attempt calls Chrome APIs, extending the worker only during this operation.
    await pause(400);
  }
  throw failure("CHATGPT_TIMEOUT", "ChatGPT did not load a usable chat composer in time. Sign in, finish loading the page, and try again." + (lastError ? " Check the extension's site access if this persists." : ""));
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function createTarget(source, deadline) {
  if (Date.now() >= deadline) throw failure("CHATGPT_TIMEOUT", "ChatGPT took too long to load. Finish loading the page and try again.");
  const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", windowId: source.windowId, active: true });
  const state = await waitForReady(tab.id, Math.min(deadline, Date.now() + 45_000), true);
  if (state.kind !== "new" || !state.empty) {
    throw failure("NEW_CHAT_REQUIRED", "ChatGPT opened an existing conversation. Start a new Chat manually and try again; no screenshot was attached.");
  }
  return { tab, state };
}

async function selectTarget(source, deadline) {
  const [{ knownConversations = [] }, { bindings = {} }, tabs] = await Promise.all([
    chrome.storage.local.get("knownConversations"),
    chrome.storage.session.get("bindings"),
    chrome.tabs.query({ url: "https://chatgpt.com/*" })
  ]);
  const candidates = tabs.filter(tab => {
    if (tab.incognito !== source.incognito) return false;
    const route = classifyChatUrl(tab.url);
    return route.kind === "new" || (route.kind === "conversation" && knownConversations.some(record => record.key === route.key));
  });
  const previouslyUsed = tab => {
    const route = classifyChatUrl(tab.url);
    return knownConversations.some(record => record.key === route.key) || (route.kind === "new" && bindings[tab.id]?.confirmed);
  };
  candidates.sort((a, b) => Number(previouslyUsed(b)) - Number(previouslyUsed(a)) ||
    (bindings[b.id]?.usedAt || 0) - (bindings[a.id]?.usedAt || 0) ||
    Number(b.windowId === source.windowId) - Number(a.windowId === source.windowId) || (b.lastAccessed || 0) - (a.lastAccessed || 0));

  const probes = await Promise.all(candidates.map(async tab => {
    try { return { tab, state: await inspect(tab.id) }; } catch { return { tab, state: null }; }
  }));
  for (const probe of probes) {
    if (eligibility(probe.state, knownConversations, bindings[probe.tab.id]) === "owned") return probe;
  }
  // Give a previously used conversation a bounded chance to load before choosing an empty chat.
  const slowOwned = probes.find(probe => previouslyUsed(probe.tab) && !probe.state?.ready && !probe.state?.workMode);
  if (slowOwned) {
    try {
      if (slowOwned.tab.discarded || slowOwned.tab.frozen) await focusTab(slowOwned.tab.id);
      const state = await waitForReady(slowOwned.tab.id, Math.min(deadline, Date.now() + 15_000));
      if (eligibility(state, knownConversations, bindings[slowOwned.tab.id]) === "owned") return { tab: slowOwned.tab, state };
    } catch { /* Continue to other eligible chats without touching their drafts. */ }
  }
  for (const probe of probes) {
    if (eligibility(probe.state, knownConversations, bindings[probe.tab.id]) !== "empty") continue;
    try {
      const state = await waitForReady(probe.tab.id, Math.min(deadline, Date.now() + 3_000));
      if (eligibility(state, knownConversations, bindings[probe.tab.id])) return { tab: probe.tab, state };
    } catch { /* A tab can disappear or navigate while selection is in progress. */ }
  }
  const slowEmpty = probes.find(probe => classifyChatUrl(probe.tab.url).kind === "new" && !probe.state?.ready && !probe.state?.workMode && !probe.tab.discarded && !probe.tab.frozen);
  if (slowEmpty) {
    try {
      const state = await waitForReady(slowEmpty.tab.id, Math.min(deadline, Date.now() + 15_000));
      if (eligibility(state, knownConversations, bindings[slowEmpty.tab.id])) return { tab: slowEmpty.tab, state };
    } catch { /* An unverified tab is never an upload destination. */ }
  }
  return createTarget(source, deadline);
}

function serializeTracking(task) {
  const result = trackingWrites.then(task);
  trackingWrites = result.catch(() => {});
  return result;
}

async function rememberConversation(key) {
  const { knownConversations = [] } = await chrome.storage.local.get("knownConversations");
  await chrome.storage.local.set({ knownConversations: [{ key, usedAt: Date.now() }, ...knownConversations.filter(record => record.key !== key)].slice(0, 200) });
}

async function trackMessage(message, sender) {
  return serializeTracking(async () => {
    const { bindings = {} } = await chrome.storage.session.get("bindings");
    const binding = bindings[sender.tab?.id];
    if (!binding || binding.token !== message.token || sender.frameId !== 0) return { ok: false };
    const tab = await chrome.tabs.get(sender.tab.id);
    const route = classifyChatUrl(tab.url);
    if (message.type === `${MESSAGE_PREFIX}attachment-confirmed`) {
      if (route.kind === "other" || route.key !== binding.key) return { ok: false };
      binding.confirmed = true;
      binding.documentId = sender.documentId;
      binding.usedAt = Date.now();
      if (route.kind === "conversation") await rememberConversation(route.key);
    } else if (message.type === `${MESSAGE_PREFIX}conversation-created`) {
      if (!binding.confirmed || sender.documentId !== binding.documentId || route.kind !== "conversation" || route.key !== message.key) return { ok: false };
      const state = await inspect(tab.id);
      if (!state?.normalChat || state.ownershipToken !== message.token || state.key !== message.key) return { ok: false };
      binding.key = route.key;
      await rememberConversation(route.key);
    } else return { ok: false };
    bindings[tab.id] = binding;
    await chrome.storage.session.set({ bindings });
    return { ok: true };
  });
}

async function attachToTarget(target, dataUrl, settings, token) {
  await focusTab(target.tab.id);
  await serializeTracking(async () => {
    const { bindings = {} } = await chrome.storage.session.get("bindings");
    bindings[target.tab.id] = { token, key: target.state.key, confirmed: false, usedAt: Date.now() };
    await chrome.storage.session.set({ bindings });
  });
  // Upload is intentionally not retried after dispatch: a lost reply may mean it succeeded.
  return chrome.tabs.sendMessage(target.tab.id, {
    type: `${MESSAGE_PREFIX}attach`, token, dataUrl, settings,
    expected: { kind: target.state.kind, key: target.state.key }
  }, { frameId: 0 });
}

async function capture(sourceHint) {
  // Acquire synchronously so rapid commands cannot race on asynchronous storage calls.
  if (inFlight) return { ok: false, code: "BUSY", message: "A screenshot is already in progress. Please wait." };
  inFlight = true;
  const token = crypto.randomUUID();
  const deadline = Date.now() + OPERATION_TIMEOUT;
  let lockAcquired = false;
  try {
    await storageReady;
    const { busy, lastCaptureAt = 0 } = await chrome.storage.session.get(["busy", "lastCaptureAt"]);
    if (busy?.expiresAt > Date.now()) return { ok: false, code: "BUSY", message: "A screenshot is already in progress. Please wait." };
    if (Date.now() - lastCaptureAt < 600) return { ok: false, code: "BUSY", message: "Please wait a moment before taking another screenshot." };
    await chrome.storage.session.set({ busy: { token, expiresAt: Date.now() + LOCK_TIMEOUT } });
    lockAcquired = true;
    const [source] = await chrome.tabs.query(sourceHint?.windowId ? { active: true, windowId: sourceHint.windowId } : { active: true, lastFocusedWindow: true });
    if (!source || (sourceHint?.id != null && source.id !== sourceHint.id)) throw failure("SOURCE_CHANGED", "The active tab changed before capture. Return to the page and try again.");
    if (!/^(https?|file):/i.test(source.url || "")) throw failure("RESTRICTED_PAGE", "Open a regular webpage and try again. Browser settings, extension pages, and other restricted pages are not supported.");
    const settings = normalizeSettings(await chrome.storage.sync.get(DEFAULT_SETTINGS));
    await safeStatus("working", "Capturing the visible page…");
    const [before] = await chrome.tabs.query({ active: true, windowId: source.windowId });
    if (before?.id !== source.id) throw failure("SOURCE_CHANGED", "The active tab changed before capture. Return to the page and try again.");
    await chrome.storage.session.set({ lastCaptureAt: Date.now() });
    let dataUrl;
    try { dataUrl = await chrome.tabs.captureVisibleTab(source.windowId, { format: "png" }); }
    catch { throw failure("CAPTURE_FAILED", "Chrome could not capture this page. Use the icon or shortcut on a regular webpage. For local files, enable “Allow access to file URLs” in extension details."); }
    const [after] = await chrome.tabs.query({ active: true, windowId: source.windowId });
    if (after?.id !== source.id) throw failure("SOURCE_CHANGED", "The active tab changed during capture. No screenshot was attached; try again.");
    await safeStatus("working", "Finding an eligible ChatGPT chat…");
    // Reserve the content script's maximum 85 seconds for attachment and optional send.
    const selectionDeadline = deadline - 85_000;
    let target = await selectTarget(source, selectionDeadline);
    await safeStatus("working", "Attaching the screenshot…");
    let result = await attachToTarget(target, dataUrl, settings, token);
    // Retry only when the content script proves no file was assigned.
    if (!result?.ok && result?.code === "TARGET_CHANGED" && result.uploadStarted === false) {
      target = await createTarget(source, selectionDeadline);
      result = await attachToTarget(target, dataUrl, settings, token);
    }
    dataUrl = null;
    if (!result?.ok) throw failure(result?.code || "ATTACH_FAILED", result?.message || "The connection to ChatGPT ended. Check the composer before retrying to avoid a duplicate attachment.");
    const message = result.warning || (result.sent ? "Screenshot sent (Auto-send is enabled)." : "Screenshot attached. Review it in ChatGPT and press Send when ready.");
    await safeStatus("success", message);
    return { ...result, message, tabId: target.tab.id };
  } catch (error) {
    const message = error.code ? error.message : "Screenshot to GPT could not finish. Check the ChatGPT composer before retrying; sign in and verify the extension's site access.";
    await safeStatus("error", message, error.code || "UNEXPECTED_ERROR");
    return { ok: false, code: error.code || "UNEXPECTED_ERROR", message };
  } finally {
    if (lockAcquired) await chrome.storage.session.remove("busy").catch(() => {});
    inFlight = false;
  }
}

// Register all event listeners synchronously, as required for MV3 workers.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture-screenshot") void capture(tab).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== "string" || !message.type.startsWith(MESSAGE_PREFIX)) return false;
  const isExtensionPage = sender.url?.startsWith(chrome.runtime.getURL("popup.html"));
  let task;
  if (message.type === `${MESSAGE_PREFIX}capture` && isExtensionPage) task = capture(message.source);
  else if (message.type === `${MESSAGE_PREFIX}status` && isExtensionPage) task = chrome.storage.session.get(["lastResult", "busy"]);
  else if ([`${MESSAGE_PREFIX}attachment-confirmed`, `${MESSAGE_PREFIX}conversation-created`].includes(message.type) && sender.tab) task = trackMessage(message, sender);
  else if (message.type === `${MESSAGE_PREFIX}heartbeat` && sender.tab) task = Promise.resolve({ ok: true });
  else return false;
  task.then(sendResponse, () => sendResponse({ ok: false, message: "Extension storage or connection is unavailable. Check the composer before retrying." }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  void serializeTracking(async () => {
    const { bindings = {} } = await chrome.storage.session.get("bindings");
    if (!bindings[tabId]) return;
    delete bindings[tabId];
    await chrome.storage.session.set({ bindings });
  }).catch(() => {});
});
