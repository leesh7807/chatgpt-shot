# App approval assist evidence

## Source and evidence type

- Approval-assist implementation commit: `3dbf7df606f92097f79a682050ba7eb665debc28`.
- Conversation identity capture fix: `5f922f76e477f02a41997fab0257947830a5dc98`.
- Evidence includes automated DOM-probe and Browser/Service boundary tests, source inspection, passive runtime diagnosis, and a branch-matched run of `scripts/smoke.mjs` using its isolated XDG and Chrome profile. The tests do not reproduce a real ChatGPT approval card.

## Observed and test-verified

- At `5f922f76e477f02a41997fab0257947830a5dc98`, `npm run build` passed.
- At the same commit, `TMPDIR=/tmp XDG_CONFIG_HOME=/tmp/chatgpt-shot-test-config XDG_DATA_HOME=/tmp/chatgpt-shot-test-data XDG_CACHE_HOME=/tmp/chatgpt-shot-test-cache npm test` passed: 150 tests, 0 failures.
- The first test run inherited `TMPDIR=/home/lees/.cache/leesh-loop-build-tmp-20261027`; the existing deep-cache-path test then constructed a temporary path over its 104-byte socket limit. Setting `TMPDIR=/tmp` made its intended short-path condition explicit, and the full suite passed. No product code or test was changed for this environment issue.
- The DOM-probe cases exercise a supported request found at the third ancestor, a match only above the allowed range, sibling-card leakage, ambiguous cards and choices, hidden ancestors, and the trusted-input adapter. Service and Browser tests cover `pending` and `in_progress`, repeated attempts, terminal cleanup, missing conversation identity, a route that appears after the first submission inspection, optional observer absence/failure, profile handoff, delayed observer startup, and concurrent Jobs.
- A passive `node dist/cli.js doctor` using the default user configuration confirmed the existing Service was accepting requests (PID `432936`) and its authenticated Service Job read and Notion read succeeded (`visible_jobs: 100`). The diagnosis did not check the private browser, inspect the running Service artifact, submit a Job, or inspect private Notion content.
- `git diff --check` passed at the implementation source commit.

## Direct isolated runtime evidence

- The exact `5f922f76e477f02a41997fab0257947830a5dc98` production CLI and Service path ran through `scripts/smoke.mjs`. Because the workspace path exceeded the broker's UNIX socket limit, the same script was invoked through a short `/tmp` symlink with `--preserve-symlinks-main`.
- User-driven manual sign-in succeeded in the separate smoke Chrome profile. Smoke submitted Job `90d7eaf5-d0b8-4b4a-b523-5a6a38a1dc79` and its `jobs` readback passed.
- Sanitized telemetry in [`runtime-smoke-2026-10-27.jsonl`](runtime-smoke-2026-10-27.jsonl) records `conversation_identity=captured` while pending, Notion `in_progress` acceptance, confirmed submission-tab closure, `approval_observation_started`, `approval_card_not_present`, Notion `completed`, and observer stop/close.
- The initial branch-matched smoke run before the fix showed `conversation_identity_missing`; the added pending-phase background read captured the route without delaying Notion acceptance. The later successful run was executed at the fix commit above.
- The smoke isolates local XDG/Service/browser state only. It uses the repository `.env`'s real Notion configuration and the manually authenticated ChatGPT account. See [smoke isolation boundary](../../verification/smoke-isolation.md).

## Direct UI evidence and limits

- The direct smoke did not produce a Notion or Chrome approval card. Its observer directly checked the submitted conversation and recorded `approval_card_not_present`; no approval-button click or resulting app permission was observed. No screenshot or private conversation content is included.
- This directly verifies the branch-matched isolated submit, Notion acceptance, independent observer start, no-card check, terminal read, and observer cleanup. It does not establish actual approval-card interaction or app permission grant.
- VR6's actual-card and actual-permission outcome therefore remains unverified. Automated DOM, Service, and Browser tests are synthetic/test evidence, not proof that an app permission was granted.

## Delivery identity

The implementation source commit is identified above. The final PR and exact delivery HEAD are recorded in the task Workpad after independent review and delivery preparation.
