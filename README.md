# Screenshot to GPT

A lightweight Chrome Manifest V3 extension that captures the visible browser viewport and attaches the PNG to an eligible **normal ChatGPT Chat**. By default it focuses the composer and leaves the screenshot **unsent**.

No OpenAI API, backend, API key, image query parameter, analytics, or build step is involved.

## Load unpacked

1. Open `chrome://extensions` in Chrome 120 or newer.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this repository folder:
   `C:\Users\techadmin\Documents\GithubProj\Screenshot-to-GPT`
4. Pin **Screenshot to GPT** from Chrome's Extensions menu.
5. Sign in to `https://chatgpt.com/` in the same Chrome profile.
6. On a webpage, press **Alt+Shift+A**, or click the extension icon. Review the attached image in ChatGPT and send it yourself when ready.

No `npm install` is needed to load or use the extension. If Chrome assigns another shortcut or another extension owns it, configure **Screenshot to GPT** at `chrome://extensions/shortcuts`.

The toolbar popup captures automatically when opened, so clicking the icon is a single capture action. Its **Send Screenshot to GPT** button also starts a capture; “Send” here means attach unless you explicitly enable Auto-send. Chrome closes the popup when the destination tab gains focus. To change settings without capturing, right-click the icon and select **Options**, or use the popup's **Open settings** link. The Options page uses the same interface; return to a webpage to capture it.

## Settings

Settings save to `chrome.storage.sync`; Chrome may sync them between your signed-in Chrome installations.

| Setting | Default | Behavior |
| --- | --- | --- |
| Default prompt | Empty | Optional text, up to 2,000 characters. |
| Insert default prompt | Off | Adds the prompt to the composer after the screenshot preview appears. Preserves existing text. |
| Auto-send | Off | Explicit opt-in to click Send after the attachment appears, upload progress clears, and Send becomes enabled. Skipped if the composer has an existing draft/attachment, a draft is typed or edited during upload, prompt insertion fails, or tracking cannot be saved. |

Leave **Auto-send** unchecked to always review screenshots before sending. Enabling it does not automatically enable prompt insertion. No code dispatches Enter or submits the composer in the default configuration.

## Which ChatGPT chat is used?

The service worker scans open `https://chatgpt.com/*` tabs in the source tab's incognito context:

1. Prefer a conversation previously used by this extension, or a still-empty draft previously used in this document.
2. Otherwise reuse a verified empty chat at `https://chatgpt.com/`.
3. Otherwise create a tab at exactly `https://chatgpt.com/`.

Only a loaded Chat composer, a root/new-chat URL, and the absence of message markers qualify as an empty chat. Every `/c/...` URL counts as an existing conversation even when message selectors stop working. An unrelated existing conversation is never an upload destination. Navigating a previously used tab to an unrelated conversation does not transfer eligibility to that conversation.

Work, Codex, task, authentication, shared-chat, and other unsupported routes are excluded. A newly created empty tab can switch to Chat using the semantic **Composer mode → Chat** control if the site defaults to Work. Existing Work tabs are not switched. If ChatGPT's mode control changes or is unavailable, the extension fails with a message asking you to open normal Chat mode.

Successful attachment confirms ownership. For a new chat, passive Send/Enter listeners detect your later submission; a bounded MutationObserver then records the conversation identifier when ChatGPT creates its URL. Clicking a sidebar conversation does not record ownership. Known conversation IDs remain eligible across reloads and Chrome restarts (up to the most recent 200). Pending empty-chat ownership is tied to the current document: reloading a draft before sending cannot safely transfer that ownership to a later conversation. An empty root can still be reused after reload. If you create the conversation while the extension is disabled, it cannot record the transition.

## Privacy and operation

- Capture occurs only on the shortcut, toolbar click, or capture button. There are no scheduled captures, background screenshots, browsing-history APIs, or analytics.
- The screenshot is captured before any destination is created or activated. Source-tab changes during capture abort the operation.
- The PNG stays in memory and is passed only to an isolated content script on ChatGPT. That script converts it to a `Blob`/`File`, assigns a `DataTransfer` to ChatGPT's real image upload input, and dispatches its normal `change` event. ChatGPT uploads it through your existing session; attaching an image can upload it to ChatGPT **before** you send the message.
- Screenshot bytes, message text, page titles, and source URLs are never stored. Local storage holds only conversation IDs and recency timestamps. Session storage holds operation status, a short-lived lock, and document/tab ownership metadata; it is cleared when Chrome restarts. Settings alone use Sync storage.
- Host access is limited to `https://chatgpt.com/*`. Permissions are exactly `activeTab`, `scripting`, and `storage`; no `tabs`, `history`, `<all_urls>`, notifications, clipboard, debugger, or offscreen permission is needed.
- Site selectors are centralized in `SELECTORS` in `chatgpt-content.js`, using accessible labels, roles, stable IDs, and fallback markup. No generated CSS classes are used.
- Composer/load waits, input discovery, attachment checks, and optional Send waits all terminate. Observers and timers are cleaned up. Route tracking begins only after a Send action; the extension has no idle polling.
- Repeated shortcuts while a capture is running are ignored. Captures are also throttled to stay below Chrome's two-per-second limit. A session lock survives a worker restart and expires if an operation is interrupted. A failed upload is not automatically retried when its outcome is uncertain; check the composer before trying again.

## Failures and troubleshooting

The toolbar badge shows **…** while working, **OK** after success, or **!** on failure. Hover over the icon or open **Options** to read the last result. Destination-side problems also display a temporary status notice in ChatGPT.

- **Restricted page / capture failure:** use the icon or shortcut on an ordinary webpage. Browser settings and extension pages are rejected. To capture local `file:` pages, enable **Allow access to file URLs** in this extension's Chrome Details page.
- **ChatGPT loads slowly:** the worker waits up to 45 seconds for a new tab; existing candidates get bounded waits. Attachment preview verification waits up to 45 seconds. Finish login or loading and retry if a wait expires.
- **Uploads unavailable:** account limits, network failures, or changed ChatGPT markup can prevent upload. The extension does not bypass limits or authentication. If it already initiated an upload, inspect the composer before retrying to avoid a duplicate.
- **Site access:** keep the extension's ChatGPT host access enabled. If Chrome restricts it to “On click,” change site access to allow `chatgpt.com`.
- **Selector change:** update the centralized selectors and run the tests. An unverified attachment is never automatically sent.
- **Worker interruption:** wait for the short-lived lock to expire (under three minutes), inspect the destination, and invoke the extension again. Screenshot bytes are not persisted or automatically replayed after a restart.

## Development and tests

Runtime code is plain JavaScript, HTML, and CSS. The only npm dependency is **development-only jsdom** for DOM integration tests; it is not loaded by Chrome.

With Node.js 24 or newer:

```sh
npm ci
npm run check
npm test
```

The automated suite exercises production scripts inside DOM fixtures and a simulated Chrome extension API. It covers all requested cases: no destination, empty-tab reuse, unrelated active conversations, previously used conversations, slow loading, selector fallbacks, and rapid repeated invocations. It also covers Work exclusion/switching, URL/navigation races, image `File` assignment, preview verification, optional prompts, opt-in Auto-send safeguards, persistent locks, document ownership, settings, manifest permissions, and packaged assets. It does not claim to emulate Chrome's actual permission grants, service-worker termination, or ChatGPT's upload server.

Live Chrome inspection verified the current accessible ChatGPT composer and image input markup. A live test upload was attempted but could not complete because the separate ChatGPT browser automation helper lacked its local-file permission. No test image or message was submitted; actual signed-in attachment remains a manual smoke test after loading the extension.

### Manual smoke tests in Chrome

Keep Auto-send off throughout these checks. Use a harmless sample page for screenshots.

| Scenario | Expected result |
| --- | --- |
| Close ChatGPT tabs; invoke the extension | Create one `https://chatgpt.com/` tab, attach one screenshot, focus the composer, leave it unsent. |
| Open an empty normal Chat tab; invoke from the sample page | Reuse that tab; no extra tab. |
| Leave only an unrelated conversation open (including as the active source) | Capture the source, create a new Chat tab, preserve the existing conversation. |
| Attach once, manually send it, then capture from the sample page again | Reuse that conversation; the second screenshot remains unsent. |
| Leave both an extension-used conversation and an empty tab open | Prefer the extension-used conversation. |
| Navigate the extension-used tab to an unrelated conversation | Do not attach there; reuse an empty chat or create one. |
| Throttle ChatGPT loading in DevTools | Wait within the documented bounds; show a clean error if loading never finishes. |
| Press Alt+Shift+A rapidly several times | One in-progress capture and attachment; no duplicate tab or image. |
| Enable prompt insertion only | Insert the prompt after upload and preserve existing text; leave unsent. |
| Open Options without invoking capture | Save settings without capturing anything. |

## Files

`manifest.json`, `background.js`, `shared.js`, `chatgpt-content.js`, `popup.html`, `popup.js`, `popup.css`, and `icons/` are the extension. `tests/`, `package.json`, and `package-lock.json` are only for development. Everything needed to load the extension is already present.

Chrome API references: [captureVisibleTab and Tabs permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs), [toolbar popups](https://developer.chrome.com/docs/extensions/reference/api/action), [extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage), and [MV3 service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
