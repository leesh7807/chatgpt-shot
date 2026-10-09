# chatgpt-shot

`chatgpt-shot` is a local utility for submitting one prompt to ChatGPT Web and tracking the matching durable Notion Invocation Job. It is repository-agnostic: configuration, the retained browser profile, and runtime discovery use XDG user locations. It never automates ChatGPT login.

## Setup

```sh
npm ci
npm run build
npm link
```

On Linux, normal operation requires `Xvfb` (for example, `sudo apt install xvfb` on Debian/Ubuntu). The browser runtime uses a private headful Chrome on a broker-owned X11 display. `chatgpt-shot open` opens the retained profile in visible system Chrome for manual sign-in or browser checks such as a Cloudflare challenge. It does not automate authentication or verify that the external page accepted the interaction.

When the Service is running, `open` keeps its HTTP process and discovery record alive. It returns `SERVICE_BUSY` while a submission admission may still be using the browser. Accepted Jobs have already had their submission tabs closed, so Notion completion polling can continue while the profile is open. New submissions receive `SERVICE_BUSY` until Chrome closes; the Service starts its private browser broker again when needed. If the Service is absent, `open` opens the profile without starting it. Use `start` separately when you want the Service running.

Configure the Notion token and Invocation database:

```sh
chatgpt-shot config set NOTION_TOKEN 'secret_notion_token'
chatgpt-shot config set CHATGPT_SHOT_NOTION_DATABASE_URL 'https://www.notion.so/your-invocation-database'
chatgpt-shot init
chatgpt-shot open
chatgpt-shot doctor
```

The configuration file is user-owned with mode `0600` at `~/.config/chatgpt-shot/.env`, or `$XDG_CONFIG_HOME/chatgpt-shot/.env`. The retained browser profile is at `~/.local/share/chatgpt-shot/chrome-profile`, and Service discovery is at `~/.cache/chatgpt-shot/runtime.json`; XDG overrides apply. `config show` never prints the token.

## Sandbox smoke

When the repository root contains its ignored `.env`, run the complete production-path smoke with one command:

```sh
npm run smoke
```

The smoke copies that configuration into the ignored `.smoke/` runtime with owner-only permissions and sets all three XDG locations there for the production CLI and its detached children. It builds and invokes the existing CLI, submits a fixed probe, then reads the returned Job UUID through `chatgpt-shot jobs`. If the retained smoke browser profile needs authentication, the smoke opens it for manual sign-in; it never automates login. After the existing CLI stops the smoke Service and drains accepted work, smoke removes runtime caches, telemetry, Chrome cache directories, profile singleton links, and other machine-local XDG files. It retains only `.smoke/config/chatgpt-shot/.env` and `.smoke/data/chatgpt-shot/chrome-profile`, preserving the authenticated profile state. A missing or invalid `.env`, browser or external readiness failure, unsuccessful submission, unreadable Job, or unsuccessful final cleanup exits with failure. A forced process or machine termination can interrupt final cleanup; the retained state is transfer-ready after a normal smoke completion. The ordinary CLI continues to use the user's XDG locations.

The optional acknowledgement budget starts immediately before the Service attempts to fill the prompt. It includes prompt filling, waiting for the Send control, browser submit attempts, and observing remote acceptance in Notion. It defaults to 3 minutes. If acceptance has not been observed after 90 seconds and the configured budget is greater than 90 seconds, the Service refills the same prompt and makes one internal retry. The original deadline remains in force:

```sh
chatgpt-shot config set CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS 180000
```

Service startup, configuration/schema validation, browser readiness, and pending Invocation creation happen before this budget. The retry reuses the same Job UUID and Notion Invocation. It may cause the prompt to run twice if the first submission was delivered but acceptance was delayed. A budget of 90 seconds or less does not start a retry. If the Service does not observe `in_progress`, `completed`, or `failed` by the original deadline, `submit` returns the existing submission error and does not mark the remote Invocation failed. A later remote State change does not change that response. There is no execution timeout: submission ends after remote acceptance, while terminal Result and Error remain Job read concerns.

## Async Job submission

The canonical flow is:

```sh
id="$(chatgpt-shot submit "Write a three-bullet release summary.")"

chatgpt-shot jobs "$id"
```

On success, `submit` prints exactly one Service-generated UUID to standard output and exits after remote acceptance is observed. It does not print a Result, State, or Error, and it does not wait for terminal completion. `chatgpt-shot jobs` lists recent Jobs; `chatgpt-shot jobs <uuid>` reads the current Job snapshot:

```json
{
  "id": "...",
  "state": "completed",
  "error": null,
  "result": "..."
}
```

For one-off browser troubleshooting, add `--diagnostics` to `submit`. On failure, the CLI prints redacted browser observations to standard error: the detected composer and send controls, whether the filled value still matches, whether the Job ID appeared in a user message, and whether the conversation route changed. It samples immediately after submission and at 500 ms, 2 s, and 5 s. Prompt text and network bodies are not included, and these observations are returned to the requesting CLI without being persisted.

```sh
chatgpt-shot submit --diagnostics "Reply with the exact phrase: probe received."
```

The durable Job is the existing Notion Invocation record. Its remote-owned lifecycle states are `in_progress`, `completed`, and `failed`; observing any of them proves remote acceptance, including when `completed` or `failed` is the first state observed. The existing remote Invocation protocol owns those writes. A failed Job's Error is the existing remote Error value and is returned unchanged by the Job read surface; submission errors are a separate caller-facing contract.

After observing remote acceptance, the Service closes the Job's browser tab and confirms that its Chrome target is gone before returning the UUID. The background observer then reads Notion only until the remote Job reaches a terminal state. This does not make terminal completion part of the `submit` command.

After the browser submit attempt, the adapter classifies prompt delivery from testable local evidence:

* `not_submitted` means evidence confirms that a particular prompt attempt did not reach ChatGPT. Local cleanup is allowed only when no attempt may have reached ChatGPT; this is not represented as a remote `failed` Job.
* `submitted` means evidence confirms prompt delivery. The local writer does not write State or Error and waits for remote acceptance.
* `uncertain` means local evidence proves neither delivery nor non-delivery. It does not end admission early: the Service continues checking Notion and makes the one eligible retry at 90 seconds even when delivery or the latest Notion State is uncertain.

An exception, interruption, acknowledgement timeout, or lost observer is not by itself evidence of `not_submitted`. If delivery cannot be proven either way, the result is `uncertain`. Once prompt delivery may have occurred, local admission failures never overwrite the remote Job lifecycle. Submission errors such as `ADMISSION_TIMEOUT`, `ADMISSION_CANCELLED`, `SUBMISSION_FAILED`, and `SUBMISSION_UNCERTAIN` are not Job lifecycle states and are not a submission history.

The caller-facing submission errors have distinct meanings:

* `SUBMISSION_FAILED`: the prompt was confirmed not sent. The Invocation was cleaned up, so a new submit attempt is safe.
* `ADMISSION_TIMEOUT`: delivery was confirmed, but Notion acceptance was not observed within the original budget. The Invocation is retained. Any eligible internal retry has already been attempted.
* `SUBMISSION_UNCERTAIN`: acceptance was not observed and delivery could not be determined, including when the deadline expires with a Notion read still in flight. The Invocation is retained. Any eligible internal retry has already been attempted.
* `NOTION_UNAVAILABLE` / `NOTION_RATE_LIMITED`: Notion observation failed and was not recovered within the admission window. The original Notion category is preserved.
* `ADMISSION_CANCELLED`: the caller or Service cancelled before acceptance was confirmed. Cancellation alone does not prove non-delivery.
* `BROWSER_CONTEXT_CLOSE_FAILED`: remote acceptance was observed, but the tab could not be confirmed closed. The accepted Job remains active; use `chatgpt-shot attempts` to find its local UUID and do not submit it again.

## Local execution telemetry

The Service records best-effort local execution events in the XDG cache:

```text
$XDG_CACHE_HOME/chatgpt-shot/jobs.jsonl
```

When `XDG_CACHE_HOME` is unset, the path is `~/.cache/chatgpt-shot/jobs.jsonl`.

Each JSONL record is correlated by Job UUID and includes local event time, elapsed time, and stage. The records cover database validation, admission Notion requests and state observations, browser readiness, tab creation/close, prompt filling, Send readiness, submit RPC outcomes, UI evidence, deadline, cleanup, cancellation, and terminal observer failure. The retry appears as another `submission_attempted` event on the same Job, with `retry_count: 1` and its reason; its Send outcome and later Notion acceptance remain in that same trail. Once remote acceptance is confirmed, repeated terminal polling is not copied into the attempt log; only the final terminal State is recorded. Prompt and Result contents, tokens, headers, and arbitrary page text are excluded. The owner-only file keeps the latest 100 submission attempts; older attempts are pruned as new submissions arrive. Timestamps describe when this local process observed an event; they are not remote state-transition timestamps.

Read the available trails without a Notion request:

```sh
chatgpt-shot attempts
chatgpt-shot attempts <uuid>
```

This is local-only diagnostic data, not a public Job surface or an additional Job lifecycle. It is not written to the Notion Invocation and does not add another Job to `submit` or `jobs`. Delete the XDG cache file to remove its telemetry.

## Local HTTP contract

The Service binds only to `127.0.0.1` on an OS-selected port. Its owner-only discovery record contains `{ pid, host, port, protocolVersion, credential }`. Treat that file as discovery only, call health before trusting it, and send the same bearer credential on every request below.

```http
GET /health
Authorization: Bearer <credential>
```

The health response includes `accepting` and `state` (`ready`, `browser-open`, or `stopping`). It is `false` while the Service is stopping or the retained browser profile is open for manual use.

```http
POST /prepare-open
Authorization: Bearer <credential>
Content-Type: application/json

{"token":"<current profile reservation token>"}
```

As part of `chatgpt-shot open`, the CLI acquires a profile lock and calls `POST /prepare-open` to ask a running Service to release its private browser broker. The CLI then opens visible Chrome locally and holds the lock until that browser process exits. This keeps the Service and `runtime.json` available, rejects submissions with `SERVICE_BUSY`, and lets `stop` shut down the Service while Chrome remains open. `/prepare-open` returns `SERVICE_BUSY` if a submission admission may still use the browser or another manual browser session is active. Accepted Jobs can continue their Notion completion polling while Chrome is open. Closing Chrome does not verify sign-in or a browser challenge.

```http
POST /jobs
Authorization: Bearer <credential>
Content-Type: application/json

{"prompt":"<non-empty prompt>"}
```

The successful response is only:

```json
{"id":"<Service-generated UUID>"}
```

The response is sent after remote acceptance and confirmed tab closure, even when the first observed state is `completed` or `failed`. Caller-supplied Job IDs are not accepted. If tab closure cannot be confirmed, the request fails with `BROWSER_CONTEXT_CLOSE_FAILED`; the remote Job remains owned by the agent and its ID can be found in the local `attempts` trail.

```http
GET /jobs
Authorization: Bearer <credential>

GET /jobs/<uuid>
Authorization: Bearer <credential>
```

`GET /jobs/<uuid>` returns the current durable State, Result, and Error. `GET /jobs` returns recent Job summaries. All Job HTTP surfaces require bearer authentication; knowing a UUID is not enough to read or create a Job.

Service failures return JSON `{ "code", "message" }` with a non-200 status. `in_progress`, `completed`, and `failed` are remote acceptance evidence, while `pending` is only the pre-acceptance Notion record state. Terminal Result and Error are read from the Job surface after submission.

Submissions are admitted in parallel; the Service does not use a FIFO submission queue. Each request has a separate Notion Invocation and browser tab/session. Shared browser authentication recovery is single-flight, and the Service spaces Notion API request starts per integration token while respecting rate-limit retry delays. The Broker's shared control tab stays open while that Broker remains available; per-Job submission tabs are closed and removed after acceptance. This coordination applies to requests made by this Service process.

For diagnostics or orderly shutdown:

```sh
chatgpt-shot start
chatgpt-shot status
chatgpt-shot port
chatgpt-shot stop
```

`stop` rejects new admissions and waits for current admission operations to finish. An accepted remote Job remains owned by ChatGPT and can be read later with its UUID.
