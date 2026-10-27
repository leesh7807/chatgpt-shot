# Technical reference

This document contains the runtime and diagnostic contracts behind the user workflow in the [README](../README.md). Use the CLI for normal operation; the HTTP interface is for authenticated local integrations.

## Configuration and runtime locations

Configuration is owner-only (0600) at `$XDG_CONFIG_HOME/chatgpt-shot/.env`, defaulting to `~/.config/chatgpt-shot/.env`. The retained browser profile is at `$XDG_DATA_HOME/chatgpt-shot/chrome-profile` or `~/.local/share/chatgpt-shot/chrome-profile`. Service discovery is at `$XDG_CACHE_HOME/chatgpt-shot/runtime.json` or `~/.cache/chatgpt-shot/runtime.json`. XDG overrides apply. `config show` never prints the token.

On Linux, the browser runtime uses headful Chrome on a private broker-owned X11 display and requires `Xvfb`. `open` instead opens the retained profile in visible system Chrome, but only after an interactive terminal user types yes at its confirmation prompt. Non-interactive calls return `USER_INTERVENTION_REQUIRED` without opening a window. It needs local XDG paths but does not require Notion configuration. If the Service is running, it keeps the Service and discovery record alive while the visible browser is open. New submissions receive `SERVICE_BUSY` until Chrome closes. Accepted Jobs can continue their Notion completion polling because their submission tabs have already closed. If the Service is absent, `open` opens the profile without starting it; use `start` separately when you want the Service running. Closing Chrome does not verify sign-in or a browser challenge.

`doctor` returns JSON with checked, skipped, and failed checks. A failed configuration check includes its code and actionable reason. By default it reads configuration, local telemetry, existing Service health, and accessible Notion state without starting a Service or browser. An authenticated read through an existing Service does not require caller-side Notion configuration. It reports the authenticated Service `/jobs` read separately from health; if that read fails, `doctor` records the failure and exits nonzero while still attempting the independent read-only Notion schema check when caller-side configuration is available. A successful Notion check does not erase the Service read failure. `doctor --browser` explicitly starts or uses the private browser runtime to check availability, ChatGPT authentication, and composer access, even when Notion configuration is unavailable; it never opens visible Chrome or submits a Job. Neither mode verifies ChatGPT-to-Notion write access.

## Submission and Job lifecycle

The durable Job is the existing Notion Invocation record. Its remote-owned states are `in_progress`, `completed`, and `failed`; observing any of them confirms acceptance, including when `completed` or `failed` is the first state observed. `pending` is a pre-acceptance Invocation state, not acceptance evidence. The existing remote Invocation protocol owns State and Error writes.

On success, `submit` prints exactly one Service-generated UUID to standard output and exits after remote acceptance. It does not print State, Result, or Error and does not wait for terminal completion. After acceptance, the Service closes the Job's browser tab and confirms that its Chrome target is gone before returning the UUID. A background observer then reads Notion only until the remote Job reaches a terminal State. `jobs` lists recent Jobs; `jobs <uuid>` reads the current Job snapshot. Both reads reuse a healthy authenticated Service even when caller-side Notion configuration is unavailable; if no usable Service exists, `jobs` needs configuration to start one. A failed Job's Error is the existing remote Error value and is returned unchanged by the Job read surface. Submission errors are a separate caller-facing contract.

After the browser submit attempt, local evidence classifies prompt delivery:

- `not_submitted`: evidence confirms the prompt did not reach ChatGPT. Only this status permits cleanup of the initial pending Invocation, and it is returned as `SUBMISSION_FAILED`.
- `submitted`: evidence confirms prompt delivery. The local writer does not write State or Error and waits for remote acceptance.
- `uncertain`: evidence proves neither delivery nor non-delivery. Admission continues checking Notion until acceptance or the acknowledgement deadline. If acceptance is not observed, the Invocation is retained and the caller receives `SUBMISSION_UNCERTAIN`.

An exception, interruption, acknowledgement timeout, or lost observer is not evidence of `not_submitted`. If delivery cannot be determined, the result is `uncertain`. Once prompt delivery may have occurred, local admission failures do not overwrite the remote Job lifecycle. Submission errors such as `ADMISSION_TIMEOUT`, `ADMISSION_CANCELLED`, `SUBMISSION_FAILED`, and `SUBMISSION_UNCERTAIN` are not Job lifecycle states or a submission history.

| Submission error | Meaning |
| --- | --- |
| `SUBMISSION_FAILED` | The prompt was confirmed not sent. The pending Invocation was cleaned up; a new submit attempt is safe. |
| `ADMISSION_TIMEOUT` | UI evidence confirmed delivery, but Notion acceptance was not observed within the budget. The Invocation is retained; do not retry automatically. |
| `SUBMISSION_UNCERTAIN` | Acceptance was not observed and delivery could not be determined, including when the deadline expires with a Notion read still in flight or the caller loses its connection after receiving an Attempt ID. If an Invocation was created, it is retained; inspect the Attempt and any remote Job, and do not retry automatically. |
| `NOTION_UNAVAILABLE` / `NOTION_RATE_LIMITED` | Notion observation failed and was not recovered within the admission window. The original Notion category is preserved. |
| `ADMISSION_CANCELLED` | The caller or Service cancelled before acceptance was confirmed. Cancellation alone does not prove non-delivery. |
| `BROWSER_CONTEXT_CLOSE_FAILED` | Remote acceptance was observed, but the tab could not be confirmed closed. The accepted Job remains active; recover its local UUID with `chatgpt-shot attempts` and do not submit it again. |

When a Service submission error occurs after its local Attempt is created, the HTTP error includes `attempt_id` and a read-only inspect command. The CLI preserves its normal `CODE: message` line and appends a `RECOVERY_JSON:` line with the correlation ID. Use `chatgpt-shot inspect <attempt-id>` to see local delivery evidence, the current Notion lookup and conservative retry guidance. The prompt is never stored in telemetry.

There is no execution timeout: submission ends after remote acceptance, while terminal Result and Error remain Job-read concerns.

## Acknowledgement budget

`CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS` controls the time from just before the Service attempts to fill the prompt through confirmation of remote acceptance. It defaults to 180000 ms (3 minutes):

```sh
chatgpt-shot config set CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS 180000
```

Service startup, configuration and schema validation, browser readiness, and pending Invocation creation happen before this budget. It includes prompt filling, waiting for the Send control, the browser submit call, and observing acceptance in Notion. If no `in_progress`, `completed`, or `failed` state is observed by the deadline, `submit` returns a failure; it does not retry or mark the remote Invocation failed. A later remote State change does not change that response.

## Browser diagnostics

For one-off browser troubleshooting, use `--diagnostics` with `submit`. On submission failure, the CLI prints redacted browser observations to standard error: detected composer and Send controls, whether the filled value still matches, whether the Job ID appeared in a user message, and whether the conversation route changed. It samples immediately after submission and at 500 ms, 2 s, and 5 s. Prompt text and network bodies are excluded; observations are returned to the requesting CLI and are not persisted.

```sh
chatgpt-shot submit --diagnostics "Reply with the exact phrase: probe received."
```

## Local execution telemetry

The Service records best-effort local events at `$XDG_CACHE_HOME/chatgpt-shot/jobs.jsonl`, or `~/.cache/chatgpt-shot/jobs.jsonl` when `XDG_CACHE_HOME` is unset. Records are correlated by Job UUID and include local event time, elapsed time, and stage. Events cover database validation, admission Notion requests and state observations, browser readiness, tab creation and close, prompt filling, Send readiness, submit RPC outcomes, UI evidence, deadline, cleanup, cancellation, and terminal observer failure. After remote acceptance, repeated terminal polling is not copied into the attempt log; only the final terminal State is recorded.

The owner-only log retains the latest 100 submission attempts and prunes older ones as new submissions arrive. It excludes prompt and Result contents, tokens, headers, and arbitrary page text. Timestamps describe when this local process observed an event, not remote state-transition times.

Read available trails without a Notion request:

```sh
chatgpt-shot attempts
chatgpt-shot attempts <uuid>
chatgpt-shot inspect <uuid>
```

`inspect` returns schema-versioned JSON. It first uses the authenticated read route of an existing Service, which does not require caller-side Notion configuration; when that route fails or is unavailable, it uses direct Notion access if caller-side configuration is available. If direct fallback succeeds after a Service read failure, the report includes both the Notion observation and the Service read failure. If remote reads remain unavailable, the report includes the source and reason; it does not turn the local Attempt into a failed or unsent Job. Retry safety is marked safe only when delivery is proven absent and any created Invocation is confirmed cleaned up or absent. The command never retries or starts a Service.

## App approval assist and observation

During normal `submit`, the Service checks for app approval cards whenever it observes the Invocation in `pending`. The broker searches from each candidate button through its third DOM ancestor and requires a supported Notion or Chrome request and one unambiguous allow/deny action group in the same bounded card context. Text elsewhere in the conversation, another card, or a shared ancestor with multiple action groups is not sufficient. Hidden, disabled, or ambiguous choices are ignored. It prefers an enabled `Always allow` button, then an enabled `Allow once`, then an enabled button labeled exactly `Allow`. The broker rechecks the same card probe immediately before sending trusted mouse input. The click is only an approval attempt; Notion State remains the sole acceptance signal. `Always allow` can persist the app permission, while `Allow once` applies to the current request. The duration of a plain `Allow` choice depends on the app's prompt.

When Notion first reports `in_progress`, the Service starts an independent observer for the exact ChatGPT `/c/<conversation-id>` route captured during submission. It starts after the submission tab has been verified closed and does not delay UUID return. If that route was not captured or the observer cannot start, the Job continues through normal Notion observation without approval handling. The observer repeats approval checks for that conversation, and stops when `completed` or `failed` is observed or the browser session becomes unavailable. It does not use the active or most recent tab as a fallback.

`--observe-approval` does not enable approval handling; it only opts in to screenshots when a click is attempted. The broker saves a small screenshot region before and after the click, then records filenames, tab index, and follow-up probe result in that click's existing `attempts` record. A fresh tab with no approval card is recorded without a screenshot. Screenshots are owner-only under `$XDG_CACHE_HOME/chatgpt-shot/observations/<job-uuid>/` or `~/.cache/chatgpt-shot/observations/<job-uuid>/`. They can contain nearby ChatGPT page content; use this option only when local image artifacts are appropriate.

```sh
chatgpt-shot submit --observe-approval "Search Notion for the page named Example and report whether it exists. Do not create or edit anything."
```

If a click is followed by another `pending` Notion read, the broker opens the same conversation in a fresh tab and checks for a Notion or Chrome approval card there. It uses at most three concurrent approval-related tabs per Job. If a fresh tab has no card, that tab branch stops while the original tab remains under observation. Notion State remains authoritative. Before UUID return, the submission tab and any pending-phase approval tabs are closed and verified. The separate in-progress observer owns its own tab set and closes it on terminal Job observation. Service stop and manual browser-profile handoff also stop approval observers; these best-effort cleanup paths do not change remote Job state or submission results.

These screenshots and event records are local diagnostics, not a public Job surface or additional Job lifecycle. They are not written to the Notion Invocation and do not change the `submit` or `jobs` contract. Delete `$XDG_CACHE_HOME/chatgpt-shot/jobs.jsonl` and `$XDG_CACHE_HOME/chatgpt-shot/observations/` to remove these local diagnostics and screenshots.

## Sandbox smoke

When the repository root contains its ignored `.env`, run the production-path smoke:

```sh
npm run smoke
```

The smoke copies that configuration into ignored `.smoke/` state with owner-only permissions, sets all three XDG locations there for the production CLI and detached children, builds and invokes the CLI, submits a fixed probe, then reads the returned Job UUID through `chatgpt-shot jobs`. If the isolated profile needs authentication, an interactive run asks before opening visible Chrome for manual sign-in; an unattended run stops with a human-intervention message and never opens a browser. It never automates login. This command performs a real external submission and is not a routine setup or repair command.

After the CLI stops the smoke Service and drains accepted work, smoke removes runtime caches, telemetry, Chrome caches, profile singleton links, and other machine-local XDG files. It retains only `.smoke/config/chatgpt-shot/.env` and `.smoke/data/chatgpt-shot/chrome-profile`, preserving the authenticated profile. A missing or invalid `.env`, browser or external readiness failure, unsuccessful submission, unreadable Job, or unsuccessful final cleanup exits with failure. Forced process or machine termination can interrupt cleanup; after normal completion, retained state is transfer-ready. The ordinary CLI continues to use the user's XDG locations.

## Authenticated local HTTP contract

The Service binds only to `127.0.0.1` on an OS-selected port. Its owner-only discovery record contains `{ pid, host, port, protocolVersion, credential }`; treat it only as discovery, call health before trusting it, and send the same bearer credential on every request. All Job and Attempt HTTP surfaces require bearer authentication; a UUID alone is not authorization.

`GET /health` returns health including `accepting` and `state` (`ready`, `browser-open`, or `stopping`). `accepting` is false while the Service is stopping or the retained browser profile is open for manual use.

```http
GET /health
Authorization: Bearer <credential>
```

As part of `chatgpt-shot open`, the CLI acquires a profile lock and calls `POST /prepare-open` with the current reservation token so a running Service can release its private browser broker. It then opens visible Chrome locally and holds the lock until Chrome exits. This keeps the Service and `runtime.json` available, rejects submissions with `SERVICE_BUSY`, and lets `stop` shut down the Service while Chrome remains open. `/prepare-open` returns `SERVICE_BUSY` if admission may still use the browser or another manual browser session is active. Accepted Jobs can continue Notion completion polling while Chrome is open. Closing Chrome does not verify sign-in or a browser challenge.

```http
POST /prepare-open
Authorization: Bearer <credential>
Content-Type: application/json

{"token":"<current profile reservation token>"}
```

`POST /jobs` accepts `{"prompt":"<non-empty prompt>"}` and optional boolean `diagnostics` and `observeApproval` fields. It does not accept caller-supplied Job IDs. Success responds only with `{"id":"<Service-generated UUID>"}` after remote acceptance and confirmed tab closure, even when the first observed State is `completed` or `failed`. If tab closure cannot be confirmed, the request fails with `BROWSER_CONTEXT_CLOSE_FAILED`; when an Attempt exists, errors include `attempt_id` and `recovery: { inspect, automatic_retry: false }` while preserving `code` and `message`.

After creating its local Attempt, the Service sends an HTTP `103 Early Hints` response with `x-chatgpt-shot-attempt-id` and a `Link` relation to `/attempts/<uuid>`. An authenticated local client can retain that ID if it cancels before the final response arrives. The final successful response contract remains `{"id":"<Service-generated UUID>"}`.

```http
POST /jobs
Authorization: Bearer <credential>
Content-Type: application/json

{"prompt":"<non-empty prompt>"}
```

`GET /jobs` returns recent Job summaries. `GET /jobs/<uuid>` returns the current durable State, Result, and Error. Service failures return JSON `{"code","message"}` with a non-200 status. `pending` is only the pre-acceptance Notion record state; terminal Result and Error are read from the Job surface after submission.

`GET /attempts/<uuid>` returns the same read-only recovery report as `chatgpt-shot inspect <uuid>`. It reads local telemetry and queries the current Invocation through the Service's configured Notion access; it does not submit a prompt or start a browser.

```http
GET /jobs
Authorization: Bearer <credential>

GET /jobs/<uuid>
Authorization: Bearer <credential>

GET /attempts/<uuid>
Authorization: Bearer <credential>
```

Submissions are admitted in parallel; the Service does not use a FIFO queue. Each request has a separate Notion Invocation and browser tab/session. Shared browser authentication recovery is single-flight, and the Service spaces Notion API request starts per integration token while respecting rate-limit retry delays. The Broker's shared control tab remains open while that Broker is available; per-Job submission tabs are closed and removed after acceptance. This coordination applies to requests made by this Service process.

`stop` rejects new admissions and waits for current admission operations to finish. An accepted remote Job remains owned by ChatGPT and can be read later with its UUID.
