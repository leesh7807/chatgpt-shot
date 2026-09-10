# chatgpt-shot

`chatgpt-shot` is a local, one-shot task utility. You submit a prompt; ChatGPT Web performs the work; the completed Result is read back from the matching Notion Invocation record and returned to you.

It is not tied to the directory you run it from. Your project files, Git repository, and project `.env` are never used.

## First-time setup

Install from this repository, then build it:

```sh
npm ci
npm run build
```

Set the two required values without opening an editor or locating a dotfile:

```sh
node dist/cli.js config set NOTION_TOKEN 'secret_notion_token'
node dist/cli.js config set CHATGPT_SHOT_NOTION_DATABASE_URL 'https://www.notion.so/your-invocation-database'
node dist/cli.js config show
```

`config show` deliberately reports only whether values are set; it never prints the token. `config path` prints the actual configuration-file path if you need it. The file is user-owned and mode `0600`; its default location is `~/.config/chatgpt-shot/.env` (or `$XDG_CONFIG_HOME/chatgpt-shot/.env`). Do not commit it.

Create or validate the configured Invocation database, then log in to ChatGPT once in normal headed Chrome:

```sh
node dist/cli.js init
node dist/cli.js login
node dist/cli.js doctor
```

`login` waits for you to finish manual authentication and close Chrome. It never enters credentials for you.

## Everyday use

```sh
node dist/cli.js submit 'Summarize the attached material and write the result to the Invocation record.'
```

`submit` starts the local Service when necessary. You normally do not need to manage it. For diagnostics or an orderly shutdown:

```sh
node dist/cli.js start
node dist/cli.js status
node dist/cli.js port
node dist/cli.js stop
```

The Service binds only `127.0.0.1` on an OS-selected port. Its owner-only discovery record supplies an ephemeral bearer credential; independent local consumers use that authenticated HTTP contract for health, submission, and stop operations. Persistent Chrome session data lives at `~/.local/share/chatgpt-shot/chrome-profile` by default and runtime discovery at `~/.cache/chatgpt-shot/runtime.json`; XDG overrides apply.

The local `NOTION_TOKEN` and ChatGPT account's Notion connection are separate. `doctor` checks local Notion access and browser readiness, but one manually authenticated `submit` is the authoritative check that ChatGPT can update the Notion record and publish its Result.
