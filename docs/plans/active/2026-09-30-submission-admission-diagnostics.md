# 2026-09-30-submission-admission-diagnostics

## Objective

`chatgpt-shot submit`은 프롬프트 작성 시도부터 최대 3분 안에 Notion Invocation의 원격 인수를 확인한 뒤에만 Job UUID를 반환한다. 제출 실패는 원인을 단계별로 판별할 수 있는 기본 로그를 남기고, 최근 100건을 CLI에서 분석할 수 있다. 승인된 제출 탭은 원격 인수가 확인된 뒤 닫는다.

## Intent

최근 Notion Invocation이 `pending`에 장시간 남아 제출 호출자가 진행 상태를 확인하지 못하는 문제가 있었다. 기존 로그 18건은 모두 `prompt_filled`와 `submission_attempted` 뒤 `submit_returned` 없이 끝났고, 후속 화면 판정이 모두 `uncertain`이었다. 해당 판정이 실제 운영상 실패로 이어졌지만, 로그는 브라우저 호출의 원래 오류를 보존하지 않아 버튼 클릭, RPC 응답, 화면 증거 중 어디서 발생했는지 가르지 못했다.

기존 18건의 저수준 원인은 이미 저장하지 않은 브라우저/네트워크 증거가 없어 소급 판정할 수 없다. 새 telemetry로 다음 실패부터 원인을 구분한다.

현재 Service는 화면 판정이 `uncertain`일 때 Notion 상태를 기다리지 않고 실패를 반환한다. 또한 acknowledgement 시간은 브라우저 제출 호출 이후부터 시작하고, Job의 terminal 상태를 기다리는 동안 브라우저 탭도 유지한다. 사용자는 원격 에이전트가 Notion `in_progress`를 기록했는지 앱이 확인할 때까지 책임져야 한다고 정했다.

동시 제출은 현재 FIFO queue 없이 진행된다. 각 작업은 독립 Invocation과 브라우저 탭을 사용하지만 공용 Broker 인증 확인과 cold start, Notion 요청량은 공유한다. 현재 Broker의 close 경로는 탭 닫기 실패를 숨길 수 있다.

## Verification Requirements

1. 3분 acknowledgement 예산은 `fillPrompt` 호출 직전에 시작하고 프롬프트 작성, 전송 버튼 대기, 브라우저 전송 호출, Notion 상태 관측을 포함한다. `in_progress`를 3분 안에 처음 관측한 뒤에만 UUID를 반환한다. 기존 계약상 `completed` 또는 `failed`가 먼저 관측되면 원격 인수의 증거로 인정한다. 기한 뒤에 도착한 상태는 이미 실패한 제출 호출을 성공으로 되돌리지 않는다.
2. 알려진 미전송, 전송 확인 후 승인 미관측, 전송 여부 불명 상태가 서로 다른 caller-facing 오류로 구분된다. 불명확하거나 전달된 제출을 자동 재시도하거나 local `failed` 상태로 덮어쓰지 않는다. 미전송을 확증하고 Notion acceptance read가 끝난 경우에만 기존 cleanup 권한을 사용한다.
3. 기본 실행에서 프롬프트 작성, 전송 버튼 판정, 브라우저 RPC, 화면 전달 증거, admission 기간의 Notion 상태 관측, deadline, cancellation, cleanup, 탭 닫기의 시작·결과·경과 시간이 기록된다. 프롬프트 본문, 페이지 본문, Notion Result/Error, 토큰, 헤더, 임의 DOM 문구는 저장하지 않는다.
4. 로컬 분석 인터페이스는 최근 100건의 제출 시도와 해당 시도의 전체 bounded event trail을 보여준다. 진단 모드 플래그가 꺼져 있어도 기본 실패 분석이 가능하며, 텔레메트리 저장 오류는 제출 lifecycle을 바꾸지 않는다.
5. 동시 제출은 Job별 Invocation과 브라우저 탭을 교차 사용하지 않는다. 공용 Broker 기동·인증 확인을 보호하고 Notion API 요청을 함께 조율한다. 제출 전체를 직렬화하는 새 queue는 두지 않는다.
6. `in_progress` 또는 기존 fast-terminal acceptance를 확인한 뒤 해당 Job의 브라우저 탭이 닫히고 Broker에서 제거된 것을 확인한 다음 ID를 반환한다. terminal State 관측은 닫힌 브라우저 탭에 의존하지 않는다. 탭 닫기 실패는 `BROWSER_CONTEXT_CLOSE_FAILED`로 응답하고 로컬 진단에 남기며, remote-owned State를 변경하지 않는다. 실패 trail에는 Job UUID가 있어 나중에 조회할 수 있다.
7. 현재 실행 중인 사용자 Service/Broker/Chrome 프로세스와 profile은 검증 과정에서 신호, 설정, 탭, 파일을 변경하지 않는다. 새 프로세스 검증은 완전히 분리된 XDG config/data/cache 경로를 사용한다.

## Definitions

**Prompt-fill attempt**: `BrowserTransport.fillPrompt()` 호출 직전. 3분 acknowledgement 예산의 시작점이다.

**Remote acceptance**: Notion에서 `in_progress`, `completed`, `failed` 중 하나를 Service가 deadline 전에 처음 관측한 것. 기존 Invocation protocol에서 terminal State도 원격 인수의 증거로 유지한다.

**Submission delivery evidence**: Broker가 관측한 Job marker의 composer/message 위치 정보. 이것은 원격 acceptance를 대신하지 않는다.

**Submission attempt record**: 내부 Job UUID로 상관된 admission 시작부터 acceptance 또는 실패까지의 로컬 이벤트 묶음.

## Decisions

1. 기존 `CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS` 설정을 재사용하고 기본값은 `180000` ms로 둔다. 기존 browser readiness, prompt-fill 자체 timeout, broker RPC timeout은 이 설정과 별개로 유지한다. 실행 중인 프로세스는 이 코드/기본값 변경에 의해 재시작되지 않는다.
2. 호출자는 `in_progress`를 확인할 때까지 기다린다. 화면에서 전송이 확실한지 여부는 Notion 관측을 건너뛰는 근거로 쓰지 않는다. 한 번 전송 호출이 시작되면 자동 재전송하지 않는다.
3. 첫 원격 State가 `completed`/`failed`인 fast-terminal Job은 기존 acceptance 계약을 유지한다. 원격 Lifecycle write는 계속 Agent 전용이다.
4. 오류 의미를 유지·정리한다.
   - `SUBMISSION_FAILED`: 프롬프트를 전달하지 않았음이 확정됨. 안전한 cleanup 뒤 재시도 가능.
   - `ADMISSION_TIMEOUT`: 전달이 확인됐지만 deadline까지 remote acceptance를 관측하지 못함. Invocation은 보존하고 자동 재시도하지 않음.
   - `SUBMISSION_UNCERTAIN`: deadline까지 acceptance가 없고 delivery evidence도 불확정하거나 Notion 상태 읽기가 아직 진행 중. Invocation을 보존하고 자동 재시도하지 않음.
   - `NOTION_UNAVAILABLE` / `NOTION_RATE_LIMITED`: acceptance 관측 중 Notion 읽기가 deadline 안에 회복되지 않음. 원래 Notion 오류 분류를 보존.
   - `ADMISSION_CANCELLED`: caller 또는 Service가 admission을 취소함. 취소 자체는 미전송 증거가 아님.
   - `BROWSER_CONTEXT_CLOSE_FAILED`: remote acceptance는 관측했으나 제출 target이 닫힌 것을 확인하지 못함. 성공 ID 대신 오류를 반환하고, 원격 Job은 보존한다.
5. deadline 도달 후 Invocation을 Notion `failed`로 바꾸지 않는다. 늦게 상태가 바뀌어도 실패한 submit 응답은 소급 성공하지 않는다. UUID는 성공 응답 전에는 반환하지 않고 로컬 `attempts` 로그로만 추적한다.
6. 제출 admission은 병렬로 허용한다. 각 Job의 페이지/CDP session은 별도다. 공유 Broker cold start와 control-page auth/recovery만 single-flight로 보호한다. `chatgpt-shot` Service 프로세스의 Notion 호출은 시작 간격을 조율하고 Notion `Retry-After`를 존중한다. 아직 전송을 시작하지 않은 대기/재시도 요청은 caller 취소 시 큐에서 제거한다. SDK 재시도에 의존하지 않고 idempotent read와 명시적 rate-limit 실패만 안전하게 재시도한다. `pages.create`처럼 응답 유실 시 중복 생성될 수 있는 write는 자동 반복하지 않는다.
7. 브라우저 context는 acceptance 확인 후 닫는다. 닫힘은 `Target.closeTarget` 응답과 target 부재 확인으로 검증하고, Broker map에서 성공한 session만 제거한다. acceptance 후 close가 최종 실패하면 caller에게 `BROWSER_CONTEXT_CLOSE_FAILED`를 반환하고 cleanup 실패를 기록한다. 원격 Job은 살아 있으며 terminal observer는 Notion만 읽는다.
8. local telemetry는 XDG cache 아래의 bounded JSONL로 유지하고 최근 100개 submission attempt를 보존한다. 기록은 attempt start 순으로 pruned; admission trail은 3분 budget으로 제한하고 acceptance 뒤 반복 terminal polling은 로그하지 않는다. terminal State 또는 observer failure만 끝에 기록한다. 데이터는 local-only이며 prompt/Notion Result/Error/인증정보를 포함하지 않는다.
9. `chatgpt-shot attempts [uuid]`는 최근 local submission diagnostic을 조회한다. `jobs`와 Notion의 authoritative Job State surface는 그대로 둔다. `--diagnostics`는 일회성 상세 브라우저 관측 옵션으로 남고, 기본 failure analysis는 이 옵션에 의존하지 않는다.
10. 기존 lifecycle event telemetry plan과 async submit plan 중 timer 시작점, 3분 admission wait, recent-100 local diagnostic readback, acceptance 후 탭 닫기 범위만 이 계획으로 갱신한다. Notion Invocation schema와 remote writer 책임은 변경하지 않는다.
11. 실제 재기동 제출에서 클릭 16ms 뒤 단일 UI sample이 message/composer 양쪽에서 marker를 발견했다. 이후 대화 영역에서 marker가 확인되면 입력창에도 marker가 남아 있어도 delivery evidence를 `submitted`로 분류한다. 이는 delivery 분류만 바꾸며 UUID 반환은 계속 Notion acceptance 확인 뒤에만 한다.

## Verification

* Service 단위 검증에서 prompt-fill 지연, submit RPC 지연/예외, `uncertain` 화면 증거, Notion `pending` 반복, deadline 직전/직후 acceptance, rate limit/cancel을 관측한다. 3분 deadline 전에 acceptance가 확인될 때만 ID가 resolve되는지 확인한다.
* 브라우저 adapter/Broker fixture에서 send-button 이유와 evidence flags가 prompt text 없이 기록되는지, 각 동시 Job이 별도 tab/session을 사용하는지, acceptance에서 대상 tab이 제거되고 close 실패가 감춰지지 않는지 확인한다.
* 동시 admission fixture에서 공용 auth/cold-start single-flight, per-job Invocation correlation, Notion request spacing/retry 정책, queue backlog/교차 tab이 없는지 확인한다.
* telemetry 검증에서 기본 모드 failure events, error taxonomy, 최근 100개 attempt pruning, CLI readback, 파일 권한, writer failure 격리를 확인한다.
* TypeScript build와 전체 자동화 테스트를 실행한다.
* 새 XDG 경로와 dummy Notion config로 별도 compiled CLI Service 프로세스를 시작하고 authenticated health/status readback 후 같은 격리 경로의 CLI로 정상 종료한다. 기존 Service PID, Broker PID, Chrome PID 및 일반 XDG discovery/profile은 검증 전후 동일해야 한다.
* 별도 프로세스의 실제 ChatGPT submit은 새 profile의 수동 인증과 실제 Notion record write가 필요하므로, 사용자 인증/외부 write 승인 없이 실행하지 않는다. 이를 못 하면 실제 Agent `in_progress` 왕복과 실제 Chrome tab cleanup은 미검증으로 명시하고, 실제 configured profile을 건드리지 않는 직접 fixture/isolated process evidence를 함께 보고한다.

## 구현 기록 및 확인 결과

* `src/service.ts`: 180초 deadline을 `fillPrompt` 직전에 시작한다. prompt-fill/send RPC는 남은 budget과 caller cancellation에 race한다. UI 관측은 진단 증거로만 쓰고 Notion acceptance polling을 계속한다. deadline을 넘긴 Notion 응답은 `late_acceptance`로 남기되 성공으로 승격하지 않는다. deadline/취소 때 상태 읽기가 진행 중이면 Invocation을 지우지 않는다.
* `src/http-service.ts` / `src/notion.ts`: admission 전체를 상관 ID로 telemetry한다. Notion queue는 같은 token의 요청 시작을 334ms 이상 간격으로 조율하고 429/529의 Retry-After와 backoff+jitter를 반영한다. safe read의 5xx만 추가 재시도하고, 응답이 불확실한 Invocation create는 반복하지 않는다. 시작 전 대기/재시도 요청은 cancellation/deadline에서 큐에서 제거되며 이미 전송된 요청은 admission race에서 늦은 응답으로 분리된다.
* `src/broker.ts` / `src/browser.ts`: Job마다 고유 CDP target/session을 사용한다. 닫기는 `Target.closeTarget` 응답뿐 아니라 `Target.getTargets`에서 target 부재를 확인한 뒤 Broker map에서 제거한다. Browser adapter도 `{ closed: true, verified: true }` 응답을 요구하고 실패 시 `BROWSER_CONTEXT_CLOSE_FAILED`를 반환한다. 정상 acceptance 경로에서는 이 닫힘 확인 후에만 ID를 반환한다.
* Broker는 병렬 Job에서 재사용하는 공용 control tab 한 개를 Broker shutdown까지 유지한다. 각 제출에 추가되는 invocation tab은 acceptance 뒤 제거한다. 따라서 정상 idle 상태에 제출 target은 남지 않지만 Broker가 살아 있는 동안 공유 control target은 남는다.
* 동시 제출 전체를 막는 FIFO queue는 추가하지 않았다. 인증/control-page 복구는 single-flight로 보호하고, 독립 제출 탭과 Invocation은 병렬로 유지한다. Notion pacing은 한 Service 프로세스와 한 configured integration token 범위다. 다른 애플리케이션/다른 Service 프로세스가 공유 workspace 제한에 쓰는 예산까지 조율하지는 않는다.
* 제출 로그는 acceptance까지의 bounded trail과 최종 terminal event만 기록한다. 수락 뒤 반복 terminal poll은 JSONL에 넣지 않아 장기 실행 Job이 기록을 무한히 늘리지 않는다. XDG cache 아래 owner-only JSONL은 최근 100개 attempt를 유지하고 `chatgpt-shot attempts [uuid]`로 읽는다. 성공 이전의 UUID는 error response에 반환하지 않는다.
* 현재 Notion 문서는 기본 연결의 평균 rate limit을 180회/분, Business/Enterprise 연결을 600회/분으로 안내한다. 334ms 간격은 기본 3회/초 수준을 넘지 않도록 한 보수적 pacing이다. workspace별 공유 제한과 `Retry-After`도 별도로 적용될 수 있다. [Notion API request limits](https://developers.notion.com/reference/request-limits)

확인 결과:

* `npm test`: 최종 변경 기준 91개 테스트 통과.
* `npx tsc -p tsconfig.json --outDir .tmp-build`: 성공. 실행용 출력은 일반 `dist` 대신 임시 디렉터리에 생성했다.
* 격리 XDG config/data/cache와 dummy Notion 설정으로 `.tmp-build/cli.js start` → authenticated `status` (`127.0.0.1:45305`, PID `263178`) → `stop`이 통과했다. 별도 Service process는 정상 종료됐고 Notion API 및 ChatGPT 브라우저는 호출하지 않았다.
* 기존 Service `187827`, Broker `209698`, Xvfb `209709`, Chrome `209715`의 PID/명령행은 격리 process 검증 전후 동일했다. 일반 XDG profile 및 discovery는 변경하지 않았다.
* 구현 당시 격리 process 검증에서는 새 profile에 수동 인증을 두지 않아 실제 ChatGPT submit→Notion acceptance 왕복을 생략했다. 이후 사용자 요청으로 기존 Service를 정상 종료하고 최신 `dist` 빌드로 재기동한 뒤 실제 configured profile에서 단건 제출을 검증했다.
* 실제 제출 Job `c4d49249-4476-4d0a-8a58-1f2074b15f86`은 `prompt_fill_started` 후 25,123ms에 Notion `in_progress`로 관측됐다. 화면 증거는 `uncertain`이었지만 Notion polling을 이어가 acceptance를 확인했고, 70ms 뒤 `browser_context_closed`가 `confirmed` / `target_open:false`로 기록된 후에만 UUID가 반환됐다. 총 38,558ms 뒤 `completed`가 관측됐으며 `jobs <uuid>`의 authoritative readback은 `state: completed`, `error: null`, `result: "재기동 검증 완료"`였다.
* 해당 실제 로그의 `uncertain`은 변경 전 classifier 결과다. 후속 결정으로 message marker가 보이는 경우 composer에도 marker가 남아 있더라도 향후 `submitted`로 판정한다. Notion acceptance 및 확인된 탭 종료 조건은 그대로 유지한다.
* 이 분류 변경 후 91개 테스트와 `npm run build`를 다시 통과시킨 뒤 Service를 재기동했다. 실제 후속 제출 Job `330faec4-7e6c-49b9-b53f-6a1675321422`에서 같은 조합(`message_marker_seen:true`, `composer_marker_present:true`)이 `submission_inspected: submitted` / `marker_in_message`로 기록됐다. Notion `in_progress`는 prompt-fill 시작 후 26,206ms에 관측됐고, 54ms 뒤 탭 종료가 `confirmed` / `target_open:false`였으며, 이후 `completed`가 관측됐다. `jobs <uuid>` readback은 `error:null`, `result:"전달 판정 재검증 완료"`였다.
* 이 실제 왕복은 3분 admission, 불확실한 화면 증거 뒤 Notion acceptance 대기, acceptance 후 실제 job target 종료 확인을 검증했다. 다른 기존 `pending` Jobs는 재기동 전 목록에서 관측됐으며 본 검증은 이들의 Notion state를 변경하지 않았다.

## Verification Tools

* `chatgpt-shot submit` / `chatgpt-shot attempts [uuid]`: caller admission과 최근 100건 진단 readback.
* `chatgpt-shot jobs <uuid>`: Notion의 authoritative State/Result/Error 확인.
* 실제 `POST /jobs` + authenticated `/health`: 별도 Service process entry point와 응답.
* injected Notion store/browser fixtures: boundary timing, delivery uncertainty, Notion rate limits, cancellation, concurrency, tab close.
* isolated XDG config/data/cache paths: 사용자 실행 process 및 retained profile 보호.
* `npm test`, `npm run build`, `git diff --check`: regression, type/build, patch hygiene.
* [Notion API request limits](https://developers.notion.com/reference/request-limits): queue spacing, `Retry-After`, 재시도 가능성 정책.
