# 2026-10-08-pending-notion-approval-assist

## Objective

기본 `submit` 대기 중 현재 Invocation의 Notion `Update Notion page` 승인 카드를 2초 간격으로 확인한다. `Always allow`를 우선 누르고, 없으면 사용자가 허용한 `Allow once`로 진행시킨다.

## Intent

ChatGPT Web에서 Notion 도구 사용 승인 카드가 반복적으로 나타나 Invocation 작업을 멈춘다. 사용자는 이 임시 자동화를 기존 제출 및 Invocation 생명주기와 분리하고, 필요 없어지면 쉽게 제거할 수 있기를 원한다.

## Verification Requirements

- 별도 모듈과 제출 루프 주입점으로 분리되어야 하며 기본 제출 경로에서 동작해야 한다.
- 기본 대기 중 2초 간격으로 현재 Invocation 탭의 승인 카드를 확인해야 한다.
- 정확한 Notion `Update Notion page` 승인 카드에서 `Always allow`를 우선하고, 없으면 `Allow once`를 누른다. 사용자가 지속 허용과 단회 허용을 명시 승인했다.
- 브라우저의 trusted mouse 입력을 보내고 클릭 뒤 카드가 사라졌는지 확인한다. 확인되지 않은 클릭은 성공으로 기록하지 않으며 다음 2초 pending 확인에서 재시도한다.
- 제공된 대화 URL에서 제목, 도구 설명, `Always allow` 버튼이 함께 보이는 것을 관측했다. 매번 확률적으로 나타나는 카드의 실제 클릭을 재현하지 않아도, 이 관측된 구조에 맞춘 probe와 회귀 테스트로 우회 경로를 검증할 수 있다.
- Notion의 `in_progress`, `completed`, `failed` 관측이 계속 제출 수락의 유일한 기준이어야 한다. 승인 보조의 부재, 오류, 카드 변경은 Invocation 상태나 기존 타임아웃/불확실성 처리에 영향을 주지 않아야 한다.
- 연결 후 실제 `submit` 흐름에서 UUID 반환과 `jobs <uuid>`의 Notion 상태/결과 readback을 확인한다.
- 적용 후 Service를 재시작한다. ChatGPT 로그인 자동화는 추가하지 않는다.

## Definitions

- **승인 보조**: 특정 Invocation 브라우저 탭에서 Notion Update 승인 카드를 찾아 허용 버튼을 누르는 선택적 의존성.
- **Invocation 수락**: Service가 Notion에서 `in_progress`, `completed`, `failed`를 관측한 상태.

## Decisions

- 승인 보조는 별도 모듈이 소유한다. `startJob` 대기 루프는 Notion `pending` 관측 뒤 모듈을 호출하고, 모듈은 브라우저 인터페이스로 probe, 허용 선택, 클릭, 사후 확인을 처리한다. broker는 페이지 평가와 trusted click primitive만 제공한다.
- 기존 2초 Notion 폴링 간격을 승인 카드 확인 간격으로 사용한다. 별도 설정이나 독립 타이머는 추가하지 않는다.
- 감지와 클릭은 Invocation의 브라우저 세션에만 한정한다. 카드 내부의 유일한 활성 허용 버튼이 확인되지 않으면 클릭하지 않는다. `Always allow`를 우선하고 없거나 비활성이면 `Allow once`를 사용한다.
- `Always allow`는 지속 권한이므로, 사용자가 이를 허용한 이 작업의 명시된 범위에서만 우선 사용한다. `Allow once`는 현재 Invocation만 허용한다.
- 승인 보조는 오류를 기존 수락 루프에 전파하지 않는 best-effort 단계로 동작한다.
- `notion_write_access_recovery` telemetry는 허용 입력 후 승인 카드가 사라져 우회가 확인된 경우에만 Job별로 남긴다. 카드가 없으면 결과 이벤트가 없다.
- 임시 URL 검증 진입점은 기본 사용자 인터페이스에 노출하지 않는다. 관측 완료 후 제거한다.
- 변경 범위는 이 승인 보조에 한정한다. CLI 계약, Notion Invocation 스키마/생명주기, 인증 흐름, 기본 2초 폴링 주기, 다른 Tool 승인 동작은 변경하지 않는다.

## Verification

- 별도 모듈의 카드 판별과 허용 버튼 선택을 회귀 테스트한다. 단축키가 붙은 라벨, 다른 승인 카드, 모호하거나 비활성인 버튼도 포함한다.
- 클릭은 DOM `.click()`이 아니라 CDP trusted mouse 입력으로 보낸다. 같은 페이지 탐색을 다시 실행해 허용 버튼이 더 이상 발견되지 않을 때 `approval_button_disappeared`를 기록한다. 이는 그 브라우저 탭의 DOM 상태만 뜻하며, Invocation 수락은 Notion readback으로만 판정한다. 버튼이 남으면 다음 pending poll에서 다시 확인한다.
- submit 경로의 probe 직렬화가 실제 브라우저 격리 문맥에서 자체 실행되는지 확인한다.
- Service를 재시작한 뒤 CLI `submit`으로 대표 prompt를 제출하고 UUID를 받은 다음 `jobs <uuid>`를 읽어 Notion의 authoritative State와 Result를 확인한다.
- 임시 URL 검증 진입점을 제거하고 최종 diff에서 제거 여부를 확인한다.
- 사용자가 허용을 승인했으므로 확률성 모달의 실제 재현을 완료 조건으로 삼지 않고, 관측된 구조와 회귀 테스트를 바탕으로 기본 루프에 연결한다.

## Verification Tools

- `npm run build`: TypeScript 구현이 빌드되는지 확인한다.
- `npm test`: 새 판별 로직과 기존 생명주기 회귀 테스트를 확인한다.
- 임시 CLI 검증 경로와 private Chrome broker: 제공된 대화 URL에서 실제 승인 카드와 클릭 결과를 관측한 뒤 검증 경로를 제거한다.
- `chatgpt-shot submit` 및 `chatgpt-shot jobs <uuid>`: 실제 제출 흐름과 Notion readback을 확인한다.

## Verification Results

- 최종 `npm run build`와 `npm test` 통과: 107/107.
- 회귀 테스트는 `Always allow` 우선, `Allow once` fallback, 실제 UI의 `Deny Esc`와 `Allow once ⏎` 라벨, 대화 내 다른 승인 카드, 격리 브라우저에서의 직렬화를 확인한다.
- 제공한 대화 URL의 사용자 탭에서 정확한 Notion 카드와 활성 `Always allow` 버튼을 읽기 전용으로 확인했다. private broker가 새로 연 사본에는 비활성 `Allow once`만 남아 있어 해당 만료 요청은 누르지 않았다.
- 임시 private broker 검증 중 실제 브라우저 직렬화에서 helper 참조 오류가 드러나 수정했다. 임시 검사 경로는 최종 소스와 빌드에서 제거했다.
- 새 빌드 Service의 실제 CLI submit Job `878eafcb-1b04-4a75-ad84-6784f0e748c1`은 `completed`로 전이했고 `jobs <uuid>` readback에서 Result `pending approval helper runtime check complete.`를 확인했다.
- 해당 Job의 이전 telemetry에는 probe 결과 `clicked` 뒤에도 수락되지 않는 케이스가 기록됐다. 기존 구현은 DOM click 호출만으로 성공을 기록하고 재시도 잠금을 유지했으므로, 이를 trusted input과 클릭 후 확인/재시도로 교체했다.
- 최종 빌드/테스트 후 Service를 재기동했고 `healthy 127.0.0.1:45211 pid=131399`을 확인했다.
