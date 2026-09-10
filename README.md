# chatgpt-shot

Standalone local utility for a one-shot ChatGPT task whose authoritative result is read from its completed Notion Invocation record.

Install and build:

```sh
npm ci
npm run build
```

Configure only the user-owned file `$XDG_CONFIG_HOME/chatgpt-shot/.env` (default: `~/.config/chatgpt-shot/.env`):

```dotenv
NOTION_TOKEN=...
CHATGPT_SHOT_NOTION_DATABASE_URL=https://www.notion.so/...
```

Persistent Chrome data is `$XDG_DATA_HOME/chatgpt-shot/chrome-profile`; runtime discovery is the owner-only `$XDG_CACHE_HOME/chatgpt-shot/runtime.json` (with conventional `~/.local/share` and `~/.cache` fallbacks). No caller repository file, working directory, or `.env` is used.

```sh
chatgpt-shot init
chatgpt-shot login
chatgpt-shot start
chatgpt-shot status
chatgpt-shot port
chatgpt-shot doctor
chatgpt-shot submit 'your task'
chatgpt-shot stop
```

The Service binds only `127.0.0.1` on an OS-selected port. Consumers read the discovery record and must send its ephemeral bearer credential to `/health`, `/submit`, or `/stop`; `submit` uses this same HTTP boundary and starts a healthy service when necessary. `stop` stops accepting work, waits for accepted work, then releases Chrome and the profile.

`login` opens headed system Chrome for manual authentication and first stops the Service to hand off profile ownership safely. The Notion API token and the ChatGPT account's Notion connection are separate authorizations. `doctor` checks local configuration and browser readiness, but a manually authenticated `submit` remains the authoritative verification of ChatGPT-to-Notion write access.
