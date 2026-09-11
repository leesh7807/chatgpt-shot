# 2026-09-11-private-virtual-display-browser-runtime

## Objective

Run the Linux normal broker's persistent, headful ChatGPT Chrome runtime on a broker-owned private X display so its windows never appear on the user's physical desktop. Preserve the dedicated profile, manual login flow, private CDP pipe, control page, and per-invocation target lifecycle.

## Definitions

- **Physical desktop**: the user's existing graphical session and its inherited `DISPLAY` value.
- **Private display**: the broker-owned Xvfb X server and the dynamically allocated `DISPLAY` value it reports.
- **Normal runtime**: the persistent broker Chrome used for `doctor` and submissions.
- **Manual login**: the existing user-visible system Chrome flow using the same dedicated profile.

## Intent

The browser must remain a normal GUI Chrome session for ChatGPT Web while its rendering destination is separated from the user's desktop. This retains authentication and startup benefits of the persistent browser without asking the user to keep, minimize, or avoid closing a runtime window.

## Decisions

- On Linux, start Xvfb before Chrome with a dynamically allocated display using Xvfb's display-file-descriptor allocation; give that display only to Chrome's child environment.
- Use the fixed `1280x800x24` Xvfb screen and do not start a window manager or desktop environment.
- Treat missing or failed Xvfb startup as `BROWSER_UNAVAILABLE`; tear down Xvfb whenever Chrome startup fails.
- Keep `--no-startup-window`, remove `--start-minimized`, and retain the private remote-debugging pipe.
- Keep `login` unchanged: it stops the broker and opens the dedicated profile in the user's visible system Chrome.
- Terminate invocation targets, control/CDP, Chrome, and Xvfb during shutdown, including bounded forced termination and failed-start cleanup.
- Do not add non-Linux virtual-display backends, headless automation, Playwright, stealth behavior, or profile changes.

## Verification

- Unit checks cover display-number parsing and Linux launch configuration, including no `--start-minimized` Chrome flag and a Chrome-only private `DISPLAY` environment.
- Build and test suites pass.
- On a Linux host with Xvfb and an authenticated profile, normal broker startup shows an Xvfb process and Chrome with a distinct `DISPLAY`; repeated invocations retain those processes while closing only invocation targets.
- Manual `login` remains a visible system-Chrome flow and the following normal runtime reuses its authenticated profile.
- Normal shutdown and a Chrome-start failure leave no Xvfb process behind.

## Verification Tools

- Node tests and TypeScript compilation verify deterministic broker behavior.
- `ps` and `/proc/<pid>/environ` can inspect the broker-owned Xvfb and Chrome display environments during the Linux smoke test.
- The CLI `login`, `doctor`, `submit`, and `stop` commands exercise profile reuse, persistent runtime, and cleanup.

## chatgpt-shot review log

- Reviewed HEAD: `46601e0563149f1d52c433dec3d17e5333f6ef4a`
- Verdict: FINDINGS
- Finding: accepted. Xvfb had no X authorization, so a different local OS user could connect through its Unix socket despite `-nolisten tcp`.
- Applied commit: `e1b5c59d24b57e3b2a0976be8e16226caf964b16`
- Verification: `npm test` (60 passed), `npm run build`, and `git diff --check` passed. Xvfb is not installed in this environment, so the live Linux display smoke test remains unavailable.

- Reviewed HEAD: `7fe44e8c9626f92438aa429eaba5884b31ce5e24`
- Verdict: PASS / no findings (`None.`)
- Findings: none; no further change was needed.
- Applied commit: none
- Verification: prior local verification remains `npm test` (60 passed), `npm run build`, and `git diff --check`.

- Reviewed HEAD: `e19ddc3af2549ad213d6e3974be90be8048f659c`
- Verdict: PASS / no findings (`None.`)
- Findings: none; no further implementation change was needed.
- Applied commit: none
- Verification: `npm test` (60 passed), `npm run build`, `git diff --check`, and an isolated Xvfb E2E run. The E2E started headful Chrome on a private display, retained the same Xvfb through a second broker request, and removed Chrome, Xvfb, and the authorization file on shutdown.
