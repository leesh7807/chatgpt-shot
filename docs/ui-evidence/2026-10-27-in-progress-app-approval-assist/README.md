# App approval assist evidence

## Source and evidence type

- Approval-assist implementation commit: `3dbf7df606f92097f79a682050ba7eb665debc28`.
- Tested branch source base: `744fc6c` (`Restore active approval assist plan during review`); implementation files are unchanged from the implementation commit.
- Evidence: automated DOM-probe and Browser/Service boundary tests, source inspection, and passive runtime diagnosis. The tests do not reproduce a real ChatGPT approval card.

## Observed and test-verified

- `npm run build` passed at the tested branch source base.
- `TMPDIR=/tmp XDG_CONFIG_HOME=/tmp/chatgpt-shot-test-config XDG_DATA_HOME=/tmp/chatgpt-shot-test-data XDG_CACHE_HOME=/tmp/chatgpt-shot-test-cache npm test` passed: 149 tests, 0 failures.
- The first test run inherited `TMPDIR=/home/lees/.cache/leesh-loop-build-tmp-20261027`; the existing deep-cache-path test then constructed a temporary path over its 104-byte socket limit. Setting `TMPDIR=/tmp` made its intended short-path condition explicit, and the full suite passed. No product code or test was changed for this environment issue.
- The DOM-probe cases exercise a supported request found at the third ancestor, a match only above the allowed range, sibling-card leakage, ambiguous cards and choices, hidden ancestors, and the trusted-input adapter. Service and Browser tests cover `pending` and `in_progress`, repeated attempts, terminal cleanup, missing conversation identity, optional observer absence/failure, profile handoff, delayed observer startup, and concurrent Jobs.
- A passive `node dist/cli.js doctor` using the default user configuration confirmed the existing Service was accepting requests (PID `432936`) and its authenticated Service Job read and Notion read succeeded (`visible_jobs: 100`). The diagnosis did not check the private browser, inspect the running Service artifact, submit a Job, or inspect private Notion content.
- `git diff --check` passed before delivery preparation.

## Direct UI evidence and limits

- No Notion or Chrome approval card was reproduced in a browser session for this delivery. No approval-button click, resulting app permission, or real `in_progress` Job approval was directly observed. No screenshot or private conversation content is included.
- The passive diagnosis establishes that a Service and Notion read are reachable; it does not establish that the running Service contains this branch's implementation or that the changed browser observation path executed.
- Therefore VR6's actual-card and actual-permission outcome remains unverified. Automated DOM, Service, and Browser tests are synthetic/test evidence, not direct browser evidence or proof that an app permission was granted.

## Delivery identity

The implementation source commit is identified above. The final PR and exact delivery HEAD are recorded in the task Workpad after independent review and delivery preparation.
