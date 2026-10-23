# chatgpt-shot

Submit a prompt to ChatGPT Web from your terminal, then follow its durable Notion Invocation Job by ID. Use it when a task can run asynchronously and you want a clear handle for checking the result later. `chatgpt-shot` runs locally, uses your retained browser profile, and never automates ChatGPT login.

> Prompt → ChatGPT Web → Notion Invocation Job → Job ID → `jobs` → State / Result / Error

```sh
job_id="$(chatgpt-shot submit 'Write a three-bullet release summary.')"
chatgpt-shot jobs "$job_id"
```

`submit` returns after remote acceptance and prints the Job ID. It does not wait for the final answer. `jobs` reads the current remote State, Result, and Error; run it again later if the Job is still in progress.

## Quick start

You need Node.js, Chrome, a Notion integration with access to an Invocation database, and a ChatGPT account you can sign in to in a browser. On Linux, normal operation also requires `Xvfb` (for example, `sudo apt install xvfb` on Debian or Ubuntu).

Install the CLI from this repository:

```sh
npm ci
npm run build
npm link
```

Set the Notion token and database URL, then create or validate the Invocation schema:

```sh
chatgpt-shot config set NOTION_TOKEN 'secret_notion_token'
chatgpt-shot config set CHATGPT_SHOT_NOTION_DATABASE_URL 'https://www.notion.so/your-invocation-database'
chatgpt-shot init
```

Sign in to ChatGPT once using the retained browser profile:

```sh
chatgpt-shot open
```

`open` opens visible Chrome for you to sign in or complete a browser check. Close the window when finished. It does not verify that sign-in or the check succeeded, and it never automates either. If the Service is already running, it remains available but rejects new submissions until Chrome closes.

The user configuration is stored with owner-only permissions under `$XDG_CONFIG_HOME/chatgpt-shot/.env`, or `~/.config/chatgpt-shot/.env` by default. `chatgpt-shot config show` reports whether the token is set without printing it. See the [technical reference](docs/technical-reference.md) for XDG paths and runtime details.

## Submit and read a Job

The normal flow is one submission followed by reads of that same Job:

1. Run `chatgpt-shot submit "<prompt>"` once and capture the UUID printed on success.
2. Run `chatgpt-shot jobs <uuid>` to read its current State, Result, or Error.
3. If State is `in_progress`, read the same UUID again later. A terminal State is `completed` or `failed`.

All three remote States—`in_progress`, `completed`, and `failed`—confirm that the Invocation was accepted. `failed` is a terminal remote Job result and its Error is read from Notion. A successful submit only confirms acceptance; it does not guarantee a successful answer or wait for completion.

A single Job read looks like this:

```json
{
  "id": "...",
  "state": "completed",
  "error": null,
  "result": "..."
}
```

`chatgpt-shot jobs` without an ID lists recent Jobs. It contacts the Notion-backed Service but does not submit a prompt. `chatgpt-shot attempts [uuid]` reads local diagnostic trails without contacting Notion.

## If something goes wrong

Treat submission errors separately from a Job that was accepted and later reached `failed`.

- **`CHATGPT_AUTH_REQUIRED` or `USER_INTERVENTION_REQUIRED`** — The prompt was not submitted. Use `open` to sign in or handle the browser check yourself, close Chrome, then submit once.
- **`SUBMISSION_FAILED`** — The CLI confirmed the prompt was not sent and cleaned up its pending Invocation. A new submission is safe.
- **`ADMISSION_TIMEOUT` or `SUBMISSION_UNCERTAIN`** — Acceptance was not observed and the prompt may have been sent. The Invocation is retained. Inspect `chatgpt-shot attempts` and the matching Job before deciding anything; do not retry automatically.
- **`NOTION_UNAVAILABLE`, `NOTION_RATE_LIMITED`, or `ADMISSION_CANCELLED`** — These do not by themselves prove that the prompt was not sent. Read the local attempt trail and available Jobs. If the original outcome remains unclear, stop and ask the user before another submission.
- **`BROWSER_CONTEXT_CLOSE_FAILED`** — Remote acceptance was observed, but the submission tab could not be confirmed closed. Find the UUID in `attempts`, read that Job, and do not submit it again.
- **`SERVICE_BUSY` or `SERVICE_STOPPING`** — The Service rejected the request before browser admission. Close a manually opened Chrome window or wait for Service startup or shutdown to finish, then retry.

For `NOTION_SCHEMA_INVALID` or configuration errors, check the configured database and integration access. `init` can create a compatible schema when the selected database is provisionable; otherwise it reports the mismatch. Do not use `doctor` as a repair command.

## Commands at a glance

| Command | Use |
| --- | --- |
| `submit "<prompt>"` | Send one prompt; success prints its accepted Job UUID. `--diagnostics` adds redacted browser observations on failure. |
| `jobs [uuid]` | List recent Jobs or read one Job's current remote State, Result, and Error. |
| `attempts [uuid]` | Read local submission diagnostics; no Notion request. |
| `config` | Open the configuration file in the default editor. |
| `config path` | Print the configuration-file path. |
| `config show` / `config set KEY VALUE` | Inspect or change local configuration. `config show` redacts the token. |
| `init` | Create or validate the configured Notion Invocation database. |
| `open` | Open visible Chrome for manual sign-in or a browser check. |
| `doctor` | Actively checks configuration, Notion schema, browser profile, authentication, and composer readiness. It may start the private browser runtime and does not test ChatGPT-to-Notion write access. |
| `start`, `status`, `port`, `stop` | Explicitly start, inspect, or stop the local Service. `submit` and `jobs` start it when needed. |

The optional `npm run smoke` command is an end-to-end verification, not routine setup. It performs a real external submission and Job read using the repository's ignored `.env`; authentication needs may open a browser for manual sign-in. See [smoke and runtime details](docs/technical-reference.md#sandbox-smoke).

For the authenticated loopback HTTP interface, detailed submission semantics, local diagnostics, and smoke cleanup behavior, see the [technical reference](docs/technical-reference.md).

## For coding agents

Use only capabilities that are available in the current environment and actions the user or parent agent has authorized. Browser access, Notion access, local CLI access, and permission to act are separate conditions; having one does not imply the others.

- **Normal path:** when the requested prompt is authorized and the CLI is available, submit it once, capture the returned UUID, and read that same Job with `chatgpt-shot jobs <uuid>`. Repeat the read to check progress; `submit` does not wait for a final Result.
- **Before another submission:** inspect `chatgpt-shot attempts [uuid]` first, then reconcile the existing Job through `chatgpt-shot jobs [uuid]` when Notion access is available. A not-yet-confirmed Job is not permission to submit again.
- **Retry only when known safe:** retry after `SUBMISSION_FAILED`, or after a request rejected before browser admission such as an authentication, user-intervention, or Service-busy error has been resolved. Never retry `ADMISSION_TIMEOUT`, `SUBMISSION_UNCERTAIN`, cancellation, or a lost Notion response unless the original Job is reconciled and the user authorizes any remaining risk.
- **Visible browser boundary:** `open` launches visible Chrome with the retained profile. Do not run it without user approval. It does not sign in or verify a challenge for the user.
- **Diagnostics are active:** `doctor` performs Notion and browser checks; it is not a general retry or repair step. `npm run smoke` makes a real submission and may open Chrome. Do not invoke either without authorization for those effects.
- **When blocked:** if CLI, Notion, browser, or interactive user capabilities are missing—or the user has not authorized the required action—do not invent a recovery path. Report what was and was not observed, the concrete limitation, and the user action needed.

See the technical reference for protocol details.
