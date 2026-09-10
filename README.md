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

Set the two required values without opening an editor or locating a dotfile:

```sh
chatgpt-shot config set NOTION_TOKEN 'secret_notion_token'
chatgpt-shot config set CHATGPT_SHOT_NOTION_DATABASE_URL 'https://www.notion.so/your-invocation-database'
chatgpt-shot config show
```

`config show` deliberately reports only whether values are set; it never prints the token. `config path` prints the actual configuration-file path if you need it. The file is user-owned and mode `0600`; its default location is `~/.config/chatgpt-shot/.env` (or `$XDG_CONFIG_HOME/chatgpt-shot/.env`). Do not commit it.

Create or validate the configured Invocation database, then log in to ChatGPT once in normal headed Chrome:

```sh
chatgpt-shot init
chatgpt-shot login
chatgpt-shot doctor
```

`login` waits for you to finish manual authentication and close Chrome. It never enters credentials for you.

## Everyday use

```sh
chatgpt-shot submit 'Summarize the attached material and write the result to the Invocation record.'
```

`submit` is synchronous: it returns only when this one invocation reaches `completed` (or a bounded failure/timeout). The command prints the exact completed Notion **Result** body to standard output, so a shell script can receive it directly:

```sh
result="$(chatgpt-shot submit 'Write a three-bullet release summary.')"
printf '%s\n' "$result"
```

Behind the command, the Service creates a fresh Notion Invocation record with its own UUID, opens a fresh ChatGPT page, and sends ChatGPT the record link and delivery protocol. ChatGPT first acknowledges the record by changing `pending` to `in_progress`, then writes the complete Result into that same page and changes it to `completed`. The CLI reads that completed page body back; it does not treat the ChatGPT assistant message as the result. On success, standard output contains only that Result; errors are reported on standard error.

If the request cannot be safely confirmed after browser submission, `submit` fails rather than silently sending a duplicate prompt. A failure state includes the Invocation Error; an execution timeout means the local wait ended and the Notion record can be inspected for later progress.

`submit` starts the local Service when necessary. You normally do not need to manage it. For diagnostics or an orderly shutdown:

```sh
chatgpt-shot start
chatgpt-shot status
chatgpt-shot port
chatgpt-shot stop
```

The Service binds only `127.0.0.1` on an OS-selected port. Its owner-only discovery record supplies an ephemeral bearer credential; independent local consumers use that authenticated HTTP contract for health, submission, and stop operations. Persistent Chrome session data lives at `~/.local/share/chatgpt-shot/chrome-profile` by default and runtime discovery at `~/.cache/chatgpt-shot/runtime.json`; XDG overrides apply.

The local `NOTION_TOKEN` and ChatGPT account's Notion connection are separate. `doctor` checks local Notion access and browser readiness, but one manually authenticated `submit` is the authoritative check that ChatGPT can update the Notion record and publish its Result.
