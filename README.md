# chatgpt-shot

`chatgpt-shot` is a local, one-shot task utility. You submit a prompt; ChatGPT Web performs the work; the completed Result is read back from the matching Notion Invocation record and returned to you.

It is not tied to the directory you run it from. Your project files, Git repository, and project `.env` are never used.

## First-time setup

Install from this repository, build it, and expose its declared `chatgpt-shot` command on your user PATH:

```sh
npm ci
npm run build
npm link
```

### Linux runtime prerequisite

Normal Linux operation requires the `Xvfb` executable. Install the package supplied by your distribution before starting the broker (for example, `sudo apt install xvfb` on Debian/Ubuntu). chatgpt-shot does not install it automatically; if it is unavailable, normal browser startup fails with `BROWSER_UNAVAILABLE` and an explanation.

Open a commented template in your system's default text editor and enter the two required values:

```sh
chatgpt-shot config
```

Alternatively, set them without opening an editor or locating a dotfile:

```sh
chatgpt-shot config set NOTION_TOKEN 'secret_notion_token'
chatgpt-shot config set CHATGPT_SHOT_NOTION_DATABASE_URL 'https://www.notion.so/your-invocation-database'
chatgpt-shot config show
```

Optional user-level lifecycle limits are milliseconds; defaults are 45 seconds for acknowledgement and 30 minutes for execution:

```sh
chatgpt-shot config set CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS 45000
chatgpt-shot config set CHATGPT_SHOT_EXECUTION_TIMEOUT_MS 1800000
```

Set `CHATGPT_SHOT_EXECUTION_TIMEOUT_MS` to `-1` to disable the **local execution** timeout and wait until the Invocation reaches a terminal state. This does not disable the 45-second acknowledgement timeout. An unlimited wait must be cancelled manually (for example, with `Ctrl-C` in the CLI or by cancelling the HTTP request); cancellation closes the local browser page and wait, but it does not undo a prompt that ChatGPT may already have accepted.

```sh
chatgpt-shot config set CHATGPT_SHOT_EXECUTION_TIMEOUT_MS -1
```

`config show` deliberately reports only whether values are set; it never prints the token. `config path` prints the actual configuration-file path if you need it. The file is user-owned and mode `0600`; its default location is `~/.config/chatgpt-shot/.env` (or `$XDG_CONFIG_HOME/chatgpt-shot/.env`). Do not commit it. A running Service reloads this file for every newly accepted submission, so the next `submit` uses a successfully saved token/database setting; work already accepted keeps its own original Invocation configuration.

Create or validate the configured Invocation database, then log in to ChatGPT once in your normal, user-visible system Chrome:

```sh
chatgpt-shot init
chatgpt-shot login
chatgpt-shot doctor
```

`login` waits for you to finish manual authentication and close Chrome. It never enters credentials for you. It uses the dedicated chatgpt-shot profile on your current desktop so you can complete authentication normally.

Each submission is expected to use the model and reasoning-effort settings of the ChatGPT profile authenticated during `login`. chatgpt-shot does not verify either setting, so confirm them in ChatGPT when they matter to a task.

## Everyday use

```sh
chatgpt-shot submit "Summarize the attached material and write the result to the Invocation record."
```

The canonical user and agent interface is `chatgpt-shot submit "<prompt>"`: it accepts exactly one non-empty positional prompt. Use `chatgpt-shot --help` (or `-h`) for the command list and `chatgpt-shot <command> --help` (or `-h`) for command-specific usage. Help is local-only and does not load configuration or contact the Service, Notion, or ChatGPT.

`submit` is synchronous: it returns only when this one invocation reaches `completed` (or a bounded failure/timeout). The command prints the exact completed Notion **Result** body to standard output, so a shell script can receive it directly:

```sh
result="$(chatgpt-shot submit "Write a three-bullet release summary.")"
printf '%s\n' "$result"
```

Behind the command, the Service creates a fresh Notion Invocation record with its own UUID, opens a fresh ChatGPT page, and sends ChatGPT the record link and delivery protocol. ChatGPT first acknowledges the record by changing `pending` to `in_progress`, then writes the complete Result into that same page and changes it to `completed`. The CLI reads that completed page body back; it does not treat the ChatGPT assistant message as the result. On success, standard output contains only that Result; errors are reported on standard error.

If the request cannot be safely confirmed after browser submission, `submit` fails rather than silently sending a duplicate prompt. A failure state includes the Invocation Error; an execution timeout means the local wait ended and the Notion record can be inspected for later progress. Unlike short health/control requests, submit has no separate client-side HTTP timeout: its Invocation lifecycle defines the normal terminal outcome.

`submit` starts the local Service when necessary. You normally do not need to manage it. For diagnostics or an orderly shutdown:

```sh
chatgpt-shot start
chatgpt-shot status
chatgpt-shot port
chatgpt-shot stop
```

The Service binds only `127.0.0.1` on an OS-selected port. Its owner-only discovery record supplies an ephemeral bearer credential; independent local consumers use that authenticated HTTP contract for health, submission, and stop operations. Persistent Chrome session data lives at `~/.local/share/chatgpt-shot/chrome-profile` by default and runtime discovery at `~/.cache/chatgpt-shot/runtime.json`; XDG overrides apply.

On Linux, normal broker operation starts ordinary headful Chrome on a broker-owned private Xvfb display rather than on your physical desktop. Chrome keeps its authenticated dedicated profile, private CDP pipe, and persistent control page, while each submission still opens and closes only its own ChatGPT invocation page. No chatgpt-shot Chrome window appears on your desktop, so you do not need to keep or minimize one. This is not headless or stealth automation. `chatgpt-shot login` is intentionally different: it opens the same dedicated profile in a visible system Chrome window; after you authenticate and close it, the private-display runtime reuses that session.

## Local HTTP contract

The discovery record is JSON at `$XDG_CACHE_HOME/chatgpt-shot/runtime.json` (default `~/.cache/chatgpt-shot/runtime.json`), mode `0600`. It contains `{ pid, host, port, protocolVersion, credential }`. Treat it as discovery only: call health before trusting it. All requests use `Authorization: Bearer <credential>` and bind to the record's `127.0.0.1:port`.

- `GET /health` returns `200 { "pid", "protocolVersion", "accepting" }` for the current Service.
- `POST /submit` accepts `{ "prompt": "..." }` and keeps the response open for that invocation's configured lifecycle. It returns `200 { "result": "completed Notion Result" }`. Concurrent requests receive distinct Invocations and never share results.
- `POST /stop` accepts `{}` and returns `200 { "stopping": true }`; new submissions are rejected while accepted work drains.

Service failures return JSON `{ "code", "message" }` with a non-200 status. Defined application codes—including `CHATGPT_AUTH_REQUIRED`, `SUBMISSION_UNCERTAIN`, `ACKNOWLEDGMENT_TIMEOUT`, `EXECUTION_TIMEOUT`, `INVOCATION_FAILED`, and `INVOCATION_CANCELLED`—must be handled by consumers rather than collapsed into a generic transport error. A client disconnect cancels that client’s local Invocation wait and closes only its browser page; it does not stop other submissions or the Service. A prompt already accepted by ChatGPT may still have remote effects, so do not automatically resubmit an `INVOCATION_CANCELLED` or `SUBMISSION_UNCERTAIN` request.

The local `NOTION_TOKEN` and ChatGPT account's Notion connection are separate. `doctor` checks local Notion access and browser readiness, but one manually authenticated `submit` is the authoritative check that ChatGPT can update the Notion record and publish its Result.
