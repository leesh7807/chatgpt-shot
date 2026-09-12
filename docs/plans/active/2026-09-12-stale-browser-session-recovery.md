# 2026-09-12-stale-browser-session-recovery

## Objective

Make chatgpt-shot remain usable when a browser tab or browser-side session disappears independently of chatgpt-shot's retained browser session state.

A stale browser session must not surface as `INTERNAL_ERROR: Session with given id not found` or require a local service restart for recovery when normal browser operation can safely continue.

Preserve the existing submission-safety boundary: recovery must not introduce a path that can submit the same prompt twice when the previous submission outcome is uncertain.

## Definitions

**Browser session**

The chatgpt-shot state representing an active browser context used to interact with ChatGPT Web.

**Stale browser session**

A browser session that chatgpt-shot still retains as usable even though the corresponding browser tab or underlying browser-side session no longer exists.

**Safe recovery**

Recovery that can establish fresh browser state without risking duplicate submission or changing the meaning of an already attempted submission.

**Submission uncertainty**

A state in which chatgpt-shot cannot determine whether a prompt was successfully submitted. Existing handling of this state remains authoritative over automatic recovery.

## Intent

chatgpt-shot keeps browser state alive across operations so normal invocations can reuse an authenticated browser runtime.

The lifetime of the retained chatgpt-shot browser session can diverge from the lifetime of the actual browser tab or browser-side session. A tab or browser-side session may disappear while chatgpt-shot still considers its corresponding session active.

The next browser operation then attempts to use that stale state and fails with `Session with given id not found`.

The desired behavior is for this mismatch to be treated as a normal browser lifecycle condition that chatgpt-shot can invalidate and recover from where recovery is safe.

## Decisions

- Treat loss of the browser-side session corresponding to a retained browser session as stale browser state, not as an unexpected internal application failure.
- When chatgpt-shot discovers that a retained browser session no longer exists on the browser side, that session is no longer reusable and must be invalidated.
- Subsequent browser work that is safe to repeat may establish fresh browser state through the normal browser path without requiring a service restart.
- Recovery must preserve existing submission-state semantics. If an operation may already have submitted a prompt and its outcome cannot be determined, chatgpt-shot must not automatically repeat the submission merely because the browser session became stale.
- Do not broaden stale-session recovery into generic retry behavior for unrelated ChatGPT Web, authentication, browser, or transport failures.
- Do not change the Notion Invocation lifecycle as part of this work. A browser failure occurring before Invocation creation must not create an Invocation solely to represent the browser transport failure.
- A local service restart remains a valid fallback for resetting browser state, but it must not be the expected recovery mechanism for an independently disappeared browser session.

## Planned implementation units

1. Identify the retained browser session lifecycle and the exact browser-side stale-session error boundary.
2. Add explicit stale-session detection and invalidation while preserving existing non-stale error mapping and submission uncertainty handling.
3. Establish fresh browser state only for operations whose work is safe to repeat, with focused automated coverage for recovery and no duplicate submission.
4. Exercise the normal CLI/service path, doctor checks, and Invocation readback where the local environment supports them.

## Verification

- With a healthy authenticated browser runtime, existing browser operations continue to work normally.
- After chatgpt-shot has established browser state, externally closing or otherwise invalidating the corresponding browser tab/session does not leave chatgpt-shot permanently bound to that stale session.
- The next operation that encounters the stale session invalidates it rather than continuing to reuse it.
- A browser operation that is safe to repeat can continue through fresh browser state without restarting the local chatgpt-shot service.
- The stale-session case no longer surfaces to the caller as `INTERNAL_ERROR: Session with given id not found`.
- Submission recovery never causes a prompt to be submitted twice when the previous submission outcome is uncertain.
- Browser failures unrelated to stale session state retain their existing error semantics.
- Browser failure before Invocation creation continues to leave no new Invocation record.

## Verification Tools

- **Automated tests** verify stale-session invalidation, safe fresh-session recovery, preservation of unrelated error behavior, and the no-duplicate-submission boundary.
- **chatgpt-shot CLI** exercises the normal submission and browser execution path and verifies user-visible failure and recovery behavior.
- **doctor** verifies authentication, browser availability, Invocation schema, and composer access before and after stale-session recovery.
- **Controlled browser-session invalidation** closes or invalidates an active browser tab/session while leaving the chatgpt-shot service running.
- **Invocation readback** verifies that pre-Invocation browser failures do not create new Invocation records and that existing Invocation lifecycle behavior remains unchanged.

