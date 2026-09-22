# chatgpt-shot

`chatgpt-shot` is a local utility for submitting one prompt to ChatGPT Web and tracking the matching durable Notion Invocation Job. It is repository-agnostic: configuration, the retained browser profile, and runtime discovery use XDG user locations. It never automates ChatGPT login.

## Setup

```sh
npm ci
npm run build
npm link
```

On Linux, normal operation requires `Xvfb` (for example, `sudo apt install xvfb` on Debian/Ubuntu). The browser runtime uses a private headful Chrome on a broker-owned X11 display. `chatgpt-shot login` opens the dedicated profile in visible system Chrome for manual authentication; enter credentials yourself, then close the window.

Configure the Notion token and Invocation database:

```sh
chatgpt-shot config set NOTION_TOKEN 'secret_notion_token'
chatgpt-shot config set CHATGPT_SHOT_NOTION_DATABASE_URL 'https://www.notion.so/your-invocation-database'
chatgpt-shot init
chatgpt-shot login
chatgpt-shot doctor
```

The configuration file is user-owned with mode `0600` at `~/.config/chatgpt-shot/.env`, or `$XDG_CONFIG_HOME/chatgpt-shot/.env`. The retained browser profile is at `~/.local/share/chatgpt-shot/chrome-profile`, and Service discovery is at `~/.cache/chatgpt-shot/runtime.json`; XDG overrides apply. `config show` never prints the token.

The only optional lifecycle setting is the acknowledgement budget after prompt submission:

```sh
chatgpt-shot config set CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS 45000
```

Service startup, configuration/schema validation, Notion calls before submission, browser readiness, Invocation creation, prompt filling, and the prompt submission operation itself are not charged to this budget. There is no execution timeout: submission ends after remote acceptance, while terminal Result and Error remain Job read concerns.

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

The durable Job is the existing Notion Invocation record. Its remote-owned lifecycle states are `in_progress`, `completed`, and `failed`; observing any of them proves remote acceptance, including when `completed` or `failed` is the first state observed. The existing remote Invocation protocol owns those writes. A failed Job's Error is the existing remote Error value and is returned unchanged by the Job read surface; submission errors are a separate caller-facing contract.

After returning the UUID, the local Service may keep the browser context and a background observer alive until the remote Job reaches a terminal state. This does not make terminal completion part of the `submit` command.

After the browser submit attempt, the adapter classifies prompt delivery from testable local evidence:

* `not_submitted` means evidence confirms that the prompt did not reach ChatGPT. Only this status permits local cleanup of the initial pending Invocation, and it is returned as a submission failure. It is not represented as a remote `failed` Job.
* `submitted` means evidence confirms prompt delivery. The local writer does not write State or Error and waits for remote acceptance.
* `uncertain` means the submit action occurred but local evidence proves neither delivery nor non-delivery. It is a caller-facing `SUBMISSION_UNCERTAIN` failure; the local writer does not write State or Error and does not clean up the Invocation.

An exception, interruption, acknowledgement timeout, or lost observer is not by itself evidence of `not_submitted`. If delivery cannot be proven either way, the result is `uncertain`. Once prompt delivery may have occurred, local admission failures never overwrite the remote Job lifecycle. Submission errors such as `ADMISSION_TIMEOUT`, `ADMISSION_CANCELLED`, `SUBMISSION_FAILED`, and `SUBMISSION_UNCERTAIN` are not Job lifecycle states and are not a submission history.

## Local execution telemetry

The Service records best-effort local execution events in the checkout that contains the running `chatgpt-shot` package:

```text
.local/chatgpt-shot/jobs.jsonl
```

Each JSONL record is correlated by Job UUID and includes the local observation timestamp. The records cover admission, Invocation creation, prompt preparation, submission, remote acceptance, terminal observation, and actual diagnostic paths such as submission inspection, cleanup, cancellation, and observer failure. Timestamps describe when this local process observed an event; they are not remote state-transition timestamps.

This is local-only diagnostic data, not a public Job surface or an additional Job lifecycle. It is not stored in XDG user state/data/cache locations, is not written to the Notion Invocation, and does not change `submit`, `jobs`, acknowledgement, cleanup, or remote State behavior. Delete the checkout's `.local/chatgpt-shot/` directory to remove its telemetry.

## Local HTTP contract

The Service binds only to `127.0.0.1` on an OS-selected port. Its owner-only discovery record contains `{ pid, host, port, protocolVersion, credential }`. Treat that file as discovery only, call health before trusting it, and send the same bearer credential on every request below.

```http
GET /health
Authorization: Bearer <credential>
```

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

The response is sent after remote acceptance, even when the first observed state is `completed` or `failed`. Caller-supplied Job IDs are not accepted.

```http
GET /jobs
Authorization: Bearer <credential>

GET /jobs/<uuid>
Authorization: Bearer <credential>
```

`GET /jobs/<uuid>` returns the current durable State, Result, and Error. `GET /jobs` returns recent Job summaries. All Job HTTP surfaces require bearer authentication; knowing a UUID is not enough to read or create a Job.

Service failures return JSON `{ "code", "message" }` with a non-200 status. `in_progress`, `completed`, and `failed` are remote acceptance evidence, while `pending` is only the pre-acceptance Notion record state. Terminal Result and Error are read from the Job surface after submission.

For diagnostics or orderly shutdown:

```sh
chatgpt-shot start
chatgpt-shot status
chatgpt-shot port
chatgpt-shot stop
```

`stop` rejects new admissions and waits for current admission operations to finish. An accepted remote Job remains owned by ChatGPT and can be read later with its UUID.
