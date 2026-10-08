/* Shared by the service worker, popup, and isolated content script. */
(() => {
  "use strict";
  const DEFAULT_SETTINGS = Object.freeze({ defaultPrompt: "", insertDefaultPrompt: false, autoSend: false });
  const MESSAGE_PREFIX = "screenshot-to-gpt/";

  function normalizeSettings(value = {}) {
    if (!value || typeof value !== "object") value = {};
    return {
      defaultPrompt: typeof value.defaultPrompt === "string" ? value.defaultPrompt.slice(0, 2000) : "",
      insertDefaultPrompt: value.insertDefaultPrompt === true,
      autoSend: value.autoSend === true
    };
  }

  function classifyChatUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== "https://chatgpt.com") return { kind: "other", key: null };
      for (const parameter of ["mode", "view", "surface"]) {
        if (/work|codex|agent|task/i.test(url.searchParams.get(parameter) || "")) return { kind: "other", key: null };
      }
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/") return { kind: "new", key: "/" };
      // Conversation identifiers survive moves into a ChatGPT project.
      const match = path.match(/^(?:\/g\/[a-zA-Z0-9_-]+)?\/c\/([a-zA-Z0-9_-]{8,128})$/);
      return match ? { kind: "conversation", key: `/c/${match[1]}` } : { kind: "other", key: null };
    } catch {
      return { kind: "other", key: null };
    }
  }

  function eligibility(state, knownConversations, binding) {
    if (!state?.ready || !state.normalChat) return null;
    if (state.kind === "conversation" && knownConversations.some(record => record.key === state.key)) return "owned";
    if (state.kind === "new" && state.empty) {
      return binding?.confirmed && binding.token === state.ownershipToken ? "owned" : "empty";
    }
    return null;
  }

  globalThis.ScreenshotToGPT = Object.freeze({ DEFAULT_SETTINGS, MESSAGE_PREFIX, normalizeSettings, classifyChatUrl, eligibility });
})();
