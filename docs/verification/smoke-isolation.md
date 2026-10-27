# Smoke isolation boundary

`npm run smoke` exercises the production CLI and Service against a real browser and Notion Invocation. It provides a separate **local runtime and browser profile**. It does not create a separate ChatGPT account, Notion integration, or external test workspace.

## What is isolated

- The smoke copies the repository root `.env` into the ignored `.smoke/config/chatgpt-shot/.env` with owner-only permissions.
- It points `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` at `.smoke/`. The production CLI, detached Service, broker runtime, diagnostics, and Chrome profile use that local state.
- Chrome uses `.smoke/data/chatgpt-shot/chrome-profile`, not the ordinary retained profile under the user's XDG data directory. The smoke starts and stops its own Service; it does not attach to, stop, or restart the ordinary user Service.
- A fresh isolated profile may require sign-in. The smoke calls `chatgpt-shot open`, which asks in an interactive terminal before opening visible Chrome. The person using the browser signs in manually. Non-interactive execution does not open a browser, and the smoke never automates login.

## What is not isolated

- `.env` is copied unchanged. The smoke uses its Notion token and configured Invocation database, so it creates a real Invocation in that database.
- The probe is sent to ChatGPT using the account manually signed in to the isolated Chrome profile. This is a real external submission, not a mock or fixture.
- A separate local profile does not make those external accounts or data test-only. Before running smoke, make sure `.env` selects the Notion database intended for test Invocations and that sending the fixed probe to the signed-in ChatGPT account is appropriate.
- Smoke reads the returned Job UUID with `chatgpt-shot jobs`. A successful smoke establishes an accepted, readable Job through that runtime. It does not assert that an app approval card appeared, that an approval button was clicked, or that an app permission was granted.

## Retained local state

On normal completion, smoke stops its Service and drains accepted work, then removes runtime caches, telemetry, Chrome caches, singleton links, and other temporary XDG files. It retains `.smoke/config/chatgpt-shot/.env` and `.smoke/data/chatgpt-shot/chrome-profile` so the isolated profile can be reused. Those retained files can contain API credentials and authenticated browser session data. Keep `.smoke/` private; do not commit, attach, or share it. Remove it only after no smoke Service or Chrome process is using the profile.

The ordinary CLI continues to use the user's XDG locations. A failed or forcibly interrupted smoke may leave isolated runtime files behind; inspect that no isolated Service or browser process remains before cleaning stale `.smoke/` state or rerunning.

## Approval-assist evidence for this delivery

The direct run used implementation commit `5f922f76e477f02a41997fab0257947830a5dc98` through the same `scripts/smoke.mjs` entry point. The repository path exceeded the broker's UNIX socket limit, so the script was launched through a short `/tmp` symlink while preserving the symlink entry path. The run used the isolated profile and the user completed manual sign-in.

For Job `90d7eaf5-d0b8-4b4a-b523-5a6a38a1dc79`, the smoke and sanitized local telemetry showed:

1. The submission inspection captured a concrete conversation identity while the Invocation was still `pending`.
2. Notion reported `in_progress`; the Service recorded acceptance and confirmed the submission tab was closed.
3. The independent approval observer started on the captured conversation, found no approval card, and made no click attempt.
4. Notion later reported `completed`; the observer stopped and its session closed. Smoke read the durable Job and passed.

The sanitized telemetry is preserved beside the approval-assist evidence README. It contains no prompt, conversation URL, Notion content, screenshot, credential, or browser profile data. This is direct evidence of the isolated production path and observer lifecycle. It does not verify the real approval-card click or resulting app permission; no supported approval card appeared during this run.
