# 2026-09-14-private-x11-browser-display

## Objective

Ensure that the Linux broker's headful Chrome runtime connects to the broker-owned private Xvfb display instead of selecting the host Wayland session.

The browser must use the dynamically allocated private X display and its matching private Xauthority file for normal Service, CLI, and smoke-submit execution. Preserve the existing authenticated loopback contract, Notion Invocation lifecycle, manual-login boundary, persistent profile, and submission-safety behavior.

## Definitions

**Private Xvfb display**

The dynamically allocated X display started by the broker for its Linux Chrome child, including its owner-controlled Xauthority file and 1280x800x24 screen.

**X11 browser backend**

Chrome's Ozone backend selected with `--ozone-platform=x11`, using the broker-provided `DISPLAY` and `XAUTHORITY` values.

**Host Wayland session**

The user's desktop Wayland environment, identified by inherited variables such as `WAYLAND_DISPLAY=wayland-0`. It is outside the broker's private display boundary.

**Virtual-display use**

Chrome having an active client connection to the private Xvfb display. This does not mean that a window should appear on the user's physical desktop; Xvfb remains a private framebuffer and `--no-startup-window` remains intentional.

**Smoke submit**

The real `chatgpt-shot submit` invocation performed by the Operator bootstrap after Service health/readiness checks. It uses the normal Service/browser path and has no separate display or headless mode.

## Intent

The current Linux runtime starts Xvfb successfully and allocates a private display, but the broker child inherits the host `WAYLAND_DISPLAY` while only overriding `DISPLAY`. The live Chrome renderer consequently selects Wayland, and the private Xvfb display has no Chrome client connection.

The fix should make the display boundary enforceable at the Chrome launch boundary and make this condition testable. A successful smoke Result must continue to mean that the normal Invocation path completed; it must not be used as evidence that Chrome selected the intended Xvfb display.

## Decisions

- On Linux, explicitly select Chrome's X11 backend with `--ozone-platform=x11` when launching the broker-owned browser.
- For the broker-owned Chrome child only, remove `WAYLAND_DISPLAY` from the inherited environment and set the allocated `DISPLAY` and private `XAUTHORITY`. Leave the broker process's own desktop environment unchanged.
- Keep Chrome headful. Do not add a `--headless` fallback, change `--no-startup-window`, or expose the private browser window on the user's physical desktop.
- Keep the private Xvfb allocation, wildcard MIT-MAGIC-COOKIE authorization, screen size, profile path, CDP pipe, and cleanup lifecycle unchanged except where required to enforce backend selection.
- Do not change `smoke submit`, the authenticated loopback HTTP contract, Notion Invocation state transitions, Result readback, or manual ChatGPT login behavior.
- Keep non-Linux browser launch behavior unchanged; the X11 backend selection is Linux-specific.
- Add regression coverage for the actual launch contract: the child environment must not retain the host Wayland selector, the Linux launch arguments must select X11, and headless flags must remain absent.
- Treat an Xvfb process without a Chrome X11 client as a failed display-isolation verification result, even if the Service health endpoint or smoke Invocation succeeds.

## Planned implementation units

1. Update the Linux broker Chrome launch contract so the child uses only the allocated private X11 display and cannot auto-select the host Wayland session.
2. Add focused broker tests covering Wayland-environment stripping, Linux X11 backend selection, private `DISPLAY`/`XAUTHORITY` propagation, headful operation, and unchanged non-Linux behavior.
3. Build and exercise a fresh broker runtime, confirming that Chrome renderer processes select X11 and that the private Xvfb display has an active Chrome client connection while the host display remains untouched.
4. Exercise `doctor`, Service health, the normal CLI/HTTP path, and one real smoke submit where the configured environment permits; confirm that the Notion Invocation lifecycle and exact Result readback remain unchanged.
5. Clarify runtime documentation if needed so operators distinguish private framebuffer use from a visible desktop window and know how display attachment is verified.

## Verification

- The Linux broker still allocates a private Xvfb display and private Xauthority file successfully.
- The broker-owned Chrome child receives the allocated `DISPLAY` and `XAUTHORITY`, does not receive `WAYLAND_DISPLAY`, and launches with `--ozone-platform=x11`.
- Chrome renderer processes report X11 rather than Wayland, and the allocated Xvfb socket has an active Chrome client connection.
- The broker's inherited host `DISPLAY`/Wayland session is not modified, and no chatgpt-shot Chrome window appears on the physical desktop as a side effect.
- Chrome remains headful and retains the existing private profile, CDP pipe, control page, invocation-page lifecycle, stale-session handling, and cleanup behavior.
- Existing unit tests and the full repository test suite pass, including tests for the existing submission uncertainty and Notion lifecycle boundaries.
- `doctor` and the authenticated loopback Service health path remain successful.
- A normal `chatgpt-shot submit` smoke invocation reaches its existing terminal Invocation state and returns the completed Notion Result without requiring a login automation change or a second submission.
- The worker-facing submit client and Operator bootstrap require no display-specific changes.
- No unrelated repository files or currently running processes are modified as part of planning or implementation setup.

## Verification Tools

- **Broker unit tests** verify the child environment and Chrome argument contract, including removal of the Wayland selector and preservation of headful behavior.
- **TypeScript build** confirms that the installed/built `dist/cli.js` path contains the corrected broker launch behavior.
- **Process inspection (`ps`, `/proc`)** observes Chrome's effective renderer backend flags and confirms that the broker parent environment remains separate from the child environment.
- **Unix-socket inspection (`ss`)** observes the private Xvfb listener and its active Chrome X11 client connection, while checking that Chrome is not attached to the host X display.
- **Xvfb/Xauthority runtime inspection** confirms the allocated private screen and matching authorization boundary without opening or mutating the physical desktop session.
- **`chatgpt-shot doctor` and authenticated loopback health** verify browser readiness and Service availability.
- **Normal `chatgpt-shot submit` / Operator smoke path** verifies the unchanged Service, browser, Notion Invocation, and exact Result-readback contract when external credentials and ChatGPT authentication are available.
- **Git status, diff inspection, and test output** verify that the change remains scoped to the display boundary and its regression coverage.
