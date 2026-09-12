# 2026-09-12-command-help-contract

## Objective

Make command-local help a complete, reliable public `chatgpt-shot` CLI inspection surface. Every public command must support `--help` and `-h`, resolve help before configuration or external dependencies, and retain existing runtime validation and behavior. Keep invocation-reference detail in the CLI contract and remove only the README guidance that teaches callers to use help.

## Definitions

**Public command** means `config`, `init`, `login`, `doctor`, `start`, `status`, `port`, `submit`, or `stop`. `__service` and `__broker` remain private detached-process entry points.

**Global help** is `chatgpt-shot --help` or `chatgpt-shot -h`; it lists public commands and points to command-local help.

**Command-local help** is `chatgpt-shot <command> --help` or `chatgpt-shot <command> -h`; it gives that command's canonical usage, purpose, and applicable arguments or forms.

## Intent

Users and agents should be able to inspect an unfamiliar command safely before invoking it. Help is an interactive CLI assistance surface, so it must not load user configuration, start or contact the Service, contact Notion or ChatGPT, launch a browser, or otherwise perform normal command side effects. The README remains focused on installation, workflows, behavior, and integration contracts rather than duplicating command-local reference.

## Decisions

- Keep the public command set and existing global `--help`/`-h` behavior.
- Define command-local help alongside the CLI parser and command contract, with one coherent implementation for all public commands.
- Recognize a command-local help token before configuration loading and before normal argument validation or execution.
- Describe `config` forms for opening configuration, `path`, `show`, and `set KEY VALUE`.
- Preserve the exact single-prompt `submit "<prompt>"` contract and keep help distinct from a real prompt.
- Do not add help surfaces for private detached-process entry points.
- Remove the README sentence that directs callers to global and command-local help, without removing normal workflow or behavior documentation.

## Verification

- Build and exercise the built `dist/cli.js` entry path.
- With an empty temporary XDG configuration environment, global help and both help flags for every public command exit 0, write command-appropriate help to stdout, and write nothing to stderr.
- Confirm help output contains the canonical usage, concise purpose, and applicable forms; specifically verify all `config` forms and the one-prompt `submit` contract.
- Use parser and CLI tests to show help tokens are scoped correctly and do not become submit prompts or execute command side effects.
- Run the existing CLI parsing/submit validation tests and the full repository test suite.
- Inspect the README diff to confirm only help-specific guidance was removed and no replacement help-reference section was added.
- Submit the exact PR HEAD SHA and PR URL to `chatgpt-shot` for review. Independently verify each reported finding against that HEAD, apply only substantiated fixes, commit them, and repeat review after exactly 60 seconds whenever a fix creates a new HEAD. Stop on PASS/None or when all findings are rejected with no new HEAD.

## Verification Tools

- TypeScript build: produces the executable path used by integration checks.
- Node CLI integration tests and direct shell probes: observe exit status, stdout, stderr, empty-config behavior, and absence of normal command effects.
- Node test runner: exercises parser, normal command parsing, submit validation, and the full suite.
- Git diff/status and README inspection: verify scope and documentation changes.
- `chatgpt-shot submit` with the current PR URL and exact HEAD SHA: performs the required external review loop; inspect the returned Result and the live HEAD before accepting or rejecting findings.

## chatgpt-shot review log

- Reviewed HEAD: `17150228bc69f46d41458735493c2da716b27c99`
- Verdict: `None.` / PASS; no findings to accept or reject.
- Applied commits: `115b4b0` (implementation and tests), `1715022` (archive plan); no review fixes.
- Verification: `npm run build` passed; `npm test` passed 61/61; built `dist/cli.js` empty-XDG probe passed for global help and all 18 public command-local help invocations; README help-guidance inspection passed.
