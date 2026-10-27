# App approval assist evidence

## Reviewed source

- Implementation commit: `3dbf7df606f92097f79a682050ba7eb665debc28`
- Evidence type: automated DOM-probe, Browser/Service boundary tests, and source inspection.

## Observed and test-verified

- `npm run build` passed for the implementation commit.
- `npm test` passed: 149 tests, 0 failures. The DOM-probe cases exercise a supported request found at the third ancestor, a match only above the allowed range, sibling-card leakage, ambiguous cards and choices, hidden ancestors, and the trusted-input adapter. Service and Browser tests cover `pending` and `in_progress`, repeated attempts, terminal cleanup, missing conversation identity, optional observer absence/failure, profile handoff, delayed observer startup, and concurrent Jobs.
- `git diff --check` passed before the implementation commit.
- The implementation captures only a validated ChatGPT `/c/<id>` route and uses it to open a separate observer page. Code and tests establish this intended route binding and lifecycle behavior; they do not establish that a real ChatGPT approval card rendered or that a real permission was granted.

## Direct UI evidence and limits

- No Notion or Chrome approval card was reproduced in a browser session for this delivery. No approval-button click, resulting app permission, or real in-progress Job transition was directly observed. No screenshot or private conversation content is included.
- A passive `node dist/cli.js doctor` attempt in the worker workspace stopped while trying to change permissions on `/home/lees/.config/chatgpt-shot` (`EROFS`). The workspace does not have authority to administer the Service. A readable worker-interface discovery file exists, but its contents and running Service artifact were not inspected or tied to this implementation commit; using it would not prove the changed code's live browser path.
- Therefore VR6's actual-card and actual-permission outcome remains unverified. The automated tests are synthetic/test evidence and are reported as such, not as direct browser evidence or proof of an app permission grant.

## Delivery identity

This record identifies the implementation source commit above. The final PR and delivery HEAD are recorded in the task Workpad after independent review preparation and delivery are complete.
