# 2026-09-23-job-execution-telemetry

## Objective

`chatgpt-shot`의 실제 Job 실행에서 소요 시간과 실패 위치를 사후 분석할 수 있도록, Job lifecycle의 주요 실행 사건과 시간을 지속적으로 남긴다.

기존 Job 제출과 durable Invocation 동작은 그대로 유지한다.

## Intent

기존 Job의 durable State, Result, Error는 보존하지만 local execution이 어느 단계까지 진행되었는지와 각 경계 사이의 시간을 실행 후 확인하기 어렵다. 향후 admission, submission, remote acceptance, terminal observation, local failure를 실제 데이터로 구분할 수 있도록 현재 local execution이 직접 관측하는 사실만 기록한다.

Telemetry는 장기간 누적될 수 있는 개발·개선용 local diagnostic data이므로 사용자 전역 상태가 아닌 실행 중인 `chatgpt-shot` checkout의 repository-local 영역에 둔다.

## Verification Requirements

1. 실제 `chatgpt-shot submit` 실행 하나의 Job ID로 연결된 telemetry가 canonical JSONL에 남고, 실제 도달한 순서대로 다음 경계를 확인할 수 있어야 한다.
   `admission_started`, `invocation_created`, `prompt_filled`, `submission_attempted`, `submit_returned`, `accepted`, `terminal_observed`.
2. 정상 Job의 기록만으로 admission 시작→acceptance, submission 시도→acceptance, acceptance→terminal, admission 시작→terminal elapsed time을 local observation timestamp로 계산할 수 있어야 한다.
3. admission caller-facing failure, submission inspection, cleanup, cancellation, acceptance 이후 observer failure는 실제 발생한 경우에만 단계와 진단 정보와 함께 남아야 한다. Acceptance 이후 local failure는 새 caller-facing error나 remote Job failure가 되어서는 안 된다.
4. telemetry는 실행 중인 checkout root의 `.local/chatgpt-shot/jobs.jsonl`에 지속되고, Service 종료 후에도 읽히며, 다른 cwd나 Service cwd의 영향을 받지 않아야 한다. `.local/`은 version control 대상이 아니어야 한다.
5. telemetry는 Job 성공·실패 판정, delivery 분류, acknowledgement budget, cleanup 조건, remote State ownership, public `submit`/`jobs` contract를 바꾸지 않아야 한다.
6. remote Invocation schema/body와 writer contract에 telemetry 책임을 추가하지 않아야 한다. 성공 `submit`은 acceptance 후 UUID 하나만 반환해야 한다.
7. telemetry 저장 실패는 Job control flow, 반환값, remote State, cleanup, submission 분류를 바꾸지 않아야 한다.

## Definitions

**Job execution telemetry**: Service가 직접 관측한 한 Job의 local execution event와 local timestamp 및 진단 정보.

**Remote acceptance**: `in_progress`, `completed`, `failed` 중 하나를 local observer가 최초로 관측한 것.

**Terminal observation**: `completed` 또는 `failed`를 local observer가 최초로 관측한 것.

**Local observation time**: remote 내부의 실제 전이 시간이 아닌, `chatgpt-shot` process가 사건을 수행하거나 관측한 시각.

## Decisions

1. Telemetry는 durable Notion Invocation과 분리된 local diagnostic record이며, canonical 저장소는 실행 checkout root 기준 단일 append-only `.local/chatgpt-shot/jobs.jsonl`이다. XDG 전역 위치, 별도 DB, Job별 파일, Notion property/body는 사용하지 않는다.
2. Job ID를 correlation key로 사용하고 모든 event에 local timestamp를 남긴다. Duration은 timestamp 차이로 계산하며 별도 authoritative 계산 상태는 저장하지 않는다.
3. 정상 중심 event는 `admission_started`, `invocation_created`, `prompt_filled`, `submission_attempted`, `submit_returned`, `accepted`, `terminal_observed`다. `accepted`와 `terminal_observed`에는 관측 State를 함께 기록한다.
4. 실제 비정상 경로에만 admission failure의 기존 code/message, local observer failure의 단계와 진단 error, inspection 결과, cleanup 결과, caller cancellation을 기록한다.
5. Telemetry writer는 best-effort side effect다. 기록 실패는 예외를 Job lifecycle로 전파하지 않으며 public stdout/stderr contract도 오염하지 않는다.
6. 기존 acknowledgement semantics, submission uncertainty, cleanup 권한, remote State ownership, local HTTP/CLI payload와 Notion schema는 protected scope다. Browser 내부 CDP/DOM/polling 세부 계측과 public telemetry 조회 API/CLI는 추가하지 않는다.
7. 파일·모듈·타입·주요 함수 이름은 local Job telemetry 책임을 직접 드러내며 범용 observability/event bus 추상화는 만들지 않는다.

## Verification

* 자동화 fixture로 정상 경로의 event 순서·State·timestamp, fast terminal, admission failure, inspection/cleanup, cancellation, acceptance 이후 observer failure, writer failure를 확인한다.
* 실제 configured Service/browser profile/Notion Invocation을 사용해 `chatgpt-shot submit` → UUID → `chatgpt-shot jobs <uuid>` terminal readback을 실행하고 동일 Job ID의 JSONL event와 timestamp를 대조한다.
* Service 종료 후 log readback, 다른 caller/Service cwd 및 별도 checkout 경계, `.local/` ignore 여부를 확인한다.
* `npm test`, `npm run build`, `git diff --check`와 최종 README/public surface/diff inspection을 수행한다.
* 실제 configured environment가 제공되지 않으면 자동화 검증 결과와 정확한 end-to-end 미검증 범위를 보고하고, 성공 시 실제 Service/Notion authoritative readback을 별도로 남긴다.

## Verification Tools

* `chatgpt-shot submit` / `chatgpt-shot jobs <uuid>`: 기존 public flow와 durable readback.
* `.local/chatgpt-shot/jobs.jsonl`: persistent event, timestamp, State, error, inspection, cleanup evidence.
* 별도 checkout/cwd 및 version control inspection: repository-local storage 경계.
* Browser/Notion controllable fixtures: failure, inspection, cleanup, observer, fast terminal 경로.
* Telemetry writer failure fixture: diagnostic side effect 격리.
* `npm test`, `npm run build`, `git diff --check`: regression, type/build, hygiene.

## chatgpt-shot review log

- Reviewed HEAD: `70da5a762fe163ef42ff36751e9bb39b04cac57c`
- Verdict: `PASS`
- Finding accepted from prior round: `test/job-telemetry.test.ts:6-8` checkout-name hardcoding; fixed by deriving the expected root from the test file location.
- Applied commit: `70da5a762fe163ef42ff36751e9bb39b04cac57c`
- Verification: `npm test` 80/80 passed, `npm run build` passed, `git diff HEAD^ HEAD --check` passed, and the telemetry-root test passed in a differently named worktree. PR ledger comments recorded the prior finding and this PASS.
