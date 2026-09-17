# 2026-09-16-async-job-submit

## Objective

`chatgpt-shot submit "<prompt>"`을 완료 Result를 기다리는 동기 실행 명령이 아니라 durable Job을 접수하는 비동기 제출 명령으로 바꾼다.

성공한 `submit`은 ChatGPT가 Job을 인수했음을 확인한 뒤 Job UUID만 stdout에 출력하고 종료한다.

이후 Job의 현재 State, Result, Error는 다음 surface에서 조회한다.

```text
chatgpt-shot jobs <uuid>
GET /jobs/<uuid>
```

기존 Notion Invocation을 durable Job 저장소로 유지한다.

별도 Job store, submission history store, wait command, synchronous compatibility mode는 만들지 않는다.

## Definitions

**Job**

하나의 prompt submission과 그 durable remote lifecycle.

기존 Notion Invocation record 하나가 Job 하나다.

**Job ID**

Service가 생성하는 UUID.

UUID는 identifier이며 capability가 아니다. HTTP에서 Job을 생성하거나 읽으려면 별도의 bearer credential이 필요하다.

**Remote acceptance**

ChatGPT가 Job을 인수해 다음 durable State 중 하나를 기록한 상태.

```text
in_progress
completed
failed
```

이 세 State는 remote writer만 기록한다.

따라서 다음 불변식을 유지한다.

```text
in_progress | completed | failed
= remote가 실제 Job을 인수한 뒤에만 도달 가능한 State
```

Local observer가 `in_progress`를 직접 보지 못하고 `completed` 또는 `failed`를 처음 읽어도 acceptance가 성립한 것으로 본다.

**Submission status**

Browser submit 이후 local path가 판단하는 prompt delivery 상태.

```text
not_submitted
submitted
uncertain
```

`not_submitted`는 prompt가 remote에 전달되지 않았음을 local evidence로 확정할 수 있을 때만 사용한다. `submitted`는 prompt 전달을 확정하는 evidence가 있을 때, 그 외 submit action 이후는 `uncertain`이다.

Durable lifecycle ownership에서는 `uncertain`을 `submitted`와 같은 쪽으로 취급한다. `not_submitted`만 cleanup 권한을 부여한다.

Browser adapter가 사용하는 구체적인 signal/selector는 구현 세부사항이지만, prompt 미전달 또는 전달을 증명하는 signal은 테스트 가능한 adapter contract로 유지한다.

**Job Error / Submission error**

Remote가 인수한 Job이 `failed`에 도달했을 때 Notion에 현재 durable하게 남은 failure information은 Job Error이며 기존 remote invocation protocol을 그대로 읽는다. `submit` 또는 `POST /jobs` 호출 자체의 실패 이유는 submission error이며 Job lifecycle state나 별도 durable taxonomy가 아니다.

## Intent

중심 경로는 다음과 같다.

```text
Service가 UUID 생성
→ Invocation 생성
→ browser submit attempt
→ delivery evidence 관찰
→ submission status 판정
```

소유권은 다음과 같다.

```text
not_submitted → prompt 미전달 확정 → local cleanup → submission failure
submitted → local lifecycle write 금지 → remote acceptance 대기 → in_progress | completed | failed
uncertain → local lifecycle write 및 cleanup 금지 → submission failure
```

실제 prompt가 remote에 전달됐을 가능성이 생긴 뒤에는 local admission failure가 durable Job lifecycle을 덮어쓰지 않는다. `in_progress | completed | failed`는 remote가 Job을 인수한 뒤에만 기록한다.

## Decisions

1. `submit`은 terminal Result가 아니라 remote acceptance evidence까지만 기다리고 UUID만 stdout에 출력한다.
2. Job ID는 Service가 생성한다. Public `POST /jobs` 요청은 `{ "prompt": "<non-empty prompt>" }`만 받으며 caller-supplied UUID, same-ID retry, duplicate-ID contract는 없다.
3. Submission status는 submit 반환값/예외가 아니라 prompt delivery evidence로 판정한다. `not_submitted`일 때만 local cleanup을 허용하고, `submitted` 또는 `uncertain` 이후 local State/Error write와 cleanup을 금지한다.
4. `in_progress`, `completed`, `failed`는 remote-owned State이며 모두 acceptance evidence다. 첫 observed state가 `completed`/`failed`여도 acceptance로 본다. `failed`의 Error metadata는 acceptance 조건이 아니다.
5. Job Error와 submission error를 분리한다. `jobs`는 현재 remote lifecycle의 State, Result, Error만 보여준다.
6. `POST /jobs` 성공 응답은 `{ "id": "<UUID>" }`뿐이다. `POST /submit`은 제거한다.
7. CLI `submit`은 canonical Job submission contract를 사용하며 성공 시 UUID 하나만 stdout에 출력한다.
8. `chatgpt-shot jobs <uuid>`와 `GET /jobs/<uuid>`는 current durable state를 반환한다. 기존 pending read 계약은 유지할 수 있으나 pending은 acceptance evidence가 아니다.
9. `POST /jobs`, `GET /jobs`, `GET /jobs/<uuid>` 모두 동일한 Service bearer credential을 요구한다.
10. `CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS`는 prompt submission 이후 acceptance evidence를 기다리는 시간만 제한한다. startup/config/Notion/browser readiness/Invocation 생성/prompt fill/submission 자체는 포함하지 않는다.
11. `CHATGPT_SHOT_EXECUTION_TIMEOUT_MS`와 terminal completion을 기다리는 local path를 configuration, help, README, timer, error path, tests에서 제거한다.
12. Acceptance handoff 뒤에는 caller가 기다리지 않지만 Service의 background browser/observer lifecycle은 remote가 terminal State를 기록할 때까지 유지할 수 있다. 이 background path에는 execution timeout을 두지 않는다.
13. `wait`, `submit --wait`, synchronous Result mode, submission outcome history, exactly-once recovery, late-write reconciliation, remote execution recovery는 추가하지 않는다.
14. README를 async Job model과 canonical CLI/HTTP flow에 맞게 갱신한다.

## Verification

다음을 자동화 테스트와 실제 configured ChatGPT Web/Notion 환경에서 확인한다.

* normal async submission은 acceptance 확인 후 UUID 하나만 stdout에 출력한다.
* 첫 observed state가 `completed` 또는 `failed`인 fast-terminal Job도 정상 반환한다.
* `not_submitted`는 확정 delivery evidence가 있을 때만 cleanup 및 submission failure가 된다.
* `submitted`는 local lifecycle write/cleanup 없이 remote acceptance를 기다린다.
* `uncertain`은 delivery evidence가 양쪽 모두 없을 때 caller-only `SUBMISSION_UNCERTAIN` failure가 되고 local write/cleanup을 하지 않는다.
* submit exception/interruption과 delivery evidence 부재는 `not_submitted`가 아니라 `uncertain`이다.
* accepted Job의 `in_progress | completed | failed`, Result, 기존 Error를 `jobs`/`GET /jobs/<uuid>`에서 읽는다.
* `not_submitted`를 remote `failed`로 표현하지 않고, submission error를 Job Error로 저장하지 않는다.
* bearer credential 없는 `POST /jobs`, `GET /jobs`, `GET /jobs/<uuid>`는 실패하고 유효한 credential은 동작한다.
* acknowledgement timeout은 prompt submission 이후부터만 측정하고 execution timeout key/path는 없다.
* `POST /submit`, synchronous CLI Result, caller ID, `wait`, `submit --wait`가 없다.
* `npm test`, `npm run build`, `git diff --check`를 실행한다.
* 실제 ChatGPT Web + configured Notion database에서 submit → UUID → jobs → terminal Result/Error 중심 경로를 한 번 관찰한다.

Remote failure serialization은 이번 변경에서 새로 정의하지 않는다.

## Verification Tools

* **실제 `chatgpt-shot` CLI**: async submission과 Job readback
* **실제 local Service HTTP interface**: `POST /jobs`, `GET /jobs`, `GET /jobs/<uuid>`, bearer authentication
* **실제 ChatGPT Web + retained browser profile**: prompt delivery와 remote acceptance
* **실제 configured Notion Invocation database**: durable Job State, Result, Error
* **submission-status fixtures**: `not_submitted`, `submitted`, `uncertain`
* **browser delivery evidence fixtures/integration path**: submission status classification
* **fast-terminal fixture**: direct `completed`/`failed` observation
* **자동화 테스트**: `npm test`
* **TypeScript build**: `npm run build`
* **repository hygiene**: `git diff --check`
