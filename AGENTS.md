# chatgpt-shot guidance

This repository owns the standalone utility. Keep callers repository-agnostic: all persistent state uses the XDG user locations, and public consumers use the authenticated loopback HTTP contract or CLI. Preserve the Notion Invocation lifecycle and do not automate ChatGPT login.

# Global Agent Instructions

## Outcome Standard

Build products for strong capability, utility, and usability in the user's actual environment, not for apparent success in tests, demos, mocks, documentation, or constrained scenarios.

Work is complete only when all applicable conditions are true:

- The requested real-world result actually exists.
- A representative user or operator can reach it naturally and efficiently through the intended entry point and primary control flow.
- Any required operation, mutation, persistence, external effect, or decision occurred and authoritative readback confirms it.
- The primary capability does not depend on an error, fallback, legacy path, fixture-specific input, mock, harness, or optimized shortcut unless explicitly required by the accepted contract.
- Implementation, tests, and every delivery slice preserve the accepted final architecture, semantics, control flow, and observable outcome.
- If later work must correct the authority, entry point, control flow, or semantics established by an earlier slice, that earlier slice is not a valid foundation.
- The result is demonstrable through the intended flow and a direct existing interface or runtime, not only through synthetic verification.

If any applicable condition is false, the work is not complete.

## Authority and Scope

Follow this authority order:

1. Current explicit user instruction and confirmed product intent.
2. Accepted requirements and product decisions.
3. Applicable repository guidance.
4. Live code and runtime behavior.
5. Tests, fixtures, mocks, harnesses, validators, and existing conventions.

Lower authority must not redefine higher authority.

- Make the smallest complete set of changes needed to deliver the accepted outcome across all affected parts of the system.
- Treat versions and phases as delivery milestones unless separate products, runtimes, or compatibility contracts are explicitly defined.
- Optimized, curated, cached, or specialized paths may improve a general capability, but must not become prerequisites for accessing it unless the accepted contract explicitly requires that restriction.
- If a test preserves the existing implementation by changing how accepted intent is interpreted, treat it as `TEST DRIFT` and change or remove it.
- If lower authority governs higher authority, stop extending that conflict. Report `AUTHORITY INVERSION`, restore the correct order, and continue.
- Pause only decisions that require policy invention or material scope expansion. Continue work that does not depend on those decisions.
- Expand scope only when required for the requested outcome, contract integrity, or safe operation. Report unrelated findings separately instead of absorbing them into the current task.
- Never weaken authorization, tenant isolation, privacy, money or settlement, data integrity, concurrency or idempotency, migrations, irreversible operations, or external-API boundaries.

## Verification

**Do not replace the requested capability with a harness.**

For AI systems, **do not kill the model with a harness.**

- Verify a representative flow through the intended entry point and primary control flow using the most direct practical existing interface.
- Do not call a flow verified if verification skips required orchestration, authorization, confirmation, user interaction, or the observable outcome by using a lower-level API or readback.
- Missing a preferred tool or environment does not justify stopping the entire task. Use the closest existing interface that preserves the required control flow and outcome, continue work that does not depend on the missing tool or environment, and report surface-specific limits precisely.
- Mocks, fixtures, replay, harnesses, validators, and certification may support verification but do not replace the requested real-world result.
- For PR review, deployment verification, and regression comparison, confirm the relevant commit or artifact identity. Report a material mismatch, but do not make identity a hard gate when it cannot affect the conclusion.
- When an actual flow fails and implementation is authorized, fix it, add the smallest regression test that reproduces it, and verify the same flow again. Otherwise, report the concrete failure and required change.
- A failure in one flow does not block independent flows unless they share the failing dependency or continuing would risk security, data, money, irreversible operations, or external effects.

## Reporting

Lead with the conclusion and real-world impact. Report only work and evidence actually completed.

For material risks, report the trigger, likelihood, impact, and required action.

Say plainly when likelihood or impact is low.

Important closeouts state the intended outcome, primary control flow, actual reachable flow and authoritative readback, test influence, authority drift, and remaining verification limits.

## PR Comment Ledger

When GitHub writes are authorized and an open PR owns the work, record material events as PR comments:

- Verification verdicts, whether PASS or FAIL, with actual evidence.
- Confirmed product or contract decisions and their rationale.
- Root causes that materially change implementation or verification.
- Contract or artifact movement that affected consumers.

Evidence reporting is independent of Ready, CI, merge, or PASS gates. Never withhold a FAIL result because a state transition is blocked.

Include the relevant head or artifact identity when it affects interpretation.

Do not turn an immaterial identity difference into a comment or progress gate.

Keep routine implementation activity in commits and dev logs.