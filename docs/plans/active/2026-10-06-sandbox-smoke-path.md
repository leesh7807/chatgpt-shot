# 2026-10-06-sandbox-smoke-path

## Objective

프로젝트 루트에 제공된 실제 `chatgpt-shot` 설정을 사용하여, 샌드박스 경계 안에서 `chatgpt-shot`의 실제 production execution path가 동작 가능한지 한 번에 검증하는 저장소 로컬 smoke 실행 경로를 제공한다.

## Intent

현재 `chatgpt-shot`의 일반 실행은 저장소와 무관하게 사용할 수 있도록 설정과 지속 상태를 XDG 사용자 위치에 둔다.

실제 사용 중인 `~/.config/chatgpt-shot/.env`의 설정 값은 프로젝트 루트의 Git 비추적 `.env`로 이미 제공되어 있다.

저장소 샌드박스 안에서 실제 `chatgpt-shot` 동작을 검증하기 위해 사용자 XDG 영역으로 샌드박스 권한을 확대하는 대신, 저장소 내부에 격리된 실행 환경을 만들고 제공된 `.env`로 실제 production path를 관통한다.

이 경로의 목적은 일반 사용자가 다른 configuration mode로 `chatgpt-shot`을 사용하는 것이 아니며, 호출자가 직접 `start`, `submit`, `jobs`를 조합하도록 하는 것도 아니다.

하나의 smoke 진입점이 실제 CLI, Service, browser, ChatGPT, Notion Invocation 경로를 사용해 현재 시스템이 동작 가능한지를 검증한다.

## Verification Requirements

- 하나의 명시적인 smoke 진입점으로 전체 검증을 실행할 수 있어야 한다.
- smoke 실행은 프로젝트 루트의 Git 비추적 `.env`를 실제 configuration source로 사용해야 한다.
- smoke 실행을 위해 사용자 `~/.config/chatgpt-shot` 및 다른 사용자 XDG `chatgpt-shot` 상태에 접근할 필요가 없어야 한다.
- smoke에 필요한 config, browser profile, Service discovery, locks 및 telemetry는 저장소 내부 Git 비추적 영역에서 사용할 수 있어야 한다.
- smoke는 기존 `chatgpt-shot`의 production CLI, Service, browser, ChatGPT 및 Notion Invocation 경로를 그대로 사용해야 한다.
- smoke 전용 submission 구현, Service, Job lifecycle 또는 Notion 대체 경로를 만들지 않는다.
- smoke 실행은 실제 prompt를 제출하고 remote acceptance 이후 실제 Job UUID를 얻어야 한다.
- smoke 실행은 반환된 UUID를 기존 Job read 경로를 통해 다시 읽어 실제 durable Job에 접근 가능함을 확인해야 한다.
- smoke의 최종 성공은 위 실제 execution path가 모두 성공했을 때만 반환되어야 한다.
- 일반 `chatgpt-shot` CLI의 XDG 기반 configuration 및 runtime 계약은 변경되지 않아야 한다.
- 루트 `.env`와 smoke runtime state는 일반 CLI에서 자동 탐색되거나 fallback으로 사용되어서는 안 된다.
- smoke 설정이나 runtime state의 비밀값은 Git 또는 실행 결과에 노출되어서는 안 된다.
- 필요한 설정이나 외부 readiness가 충족되지 않으면 smoke는 성공으로 처리하지 않고 실패 원인을 노출해야 한다.

## Definitions

- **Smoke**: `chatgpt-shot`의 실제 production execution path와 실제 외부 의존성이 현재 한 번 성공적으로 관통 가능한지 검증하는 저장소 로컬 실행.
- **Production execution path**: 기존 `chatgpt-shot` CLI → Service → browser → ChatGPT → Notion Invocation 흐름.
- **일반 실행**: 기존 `chatgpt-shot` CLI가 사용자 XDG 위치의 설정과 상태를 사용하는 실행 방식.
- **Smoke 실행 환경**: smoke가 사용하는 저장소 내부의 config, browser profile, Service discovery, locks, telemetry 및 기타 runtime state.
- **루트 `.env`**: 실제 `chatgpt-shot` 설정 값이 제공된 프로젝트 루트의 Git 비추적 파일.
- **E2E**: 특정 사용자 또는 제품 workflow의 시작부터 최종 결과까지 전체 요구사항을 검증하는 테스트. 이번 smoke와 동일한 의미로 사용하지 않는다.

## Decisions

- 저장소 로컬 검증 표면의 이름과 책임은 `smoke`로 통일한다.
- 호출자에게 `submit` 등의 production CLI 명령 조합을 smoke 사용법으로 노출하지 않는다. 하나의 smoke 진입점이 필요한 production 명령과 검증 흐름을 소유한다.
- smoke 내부에서는 기존 production CLI 및 Service 경로를 재사용한다.
- smoke 전용 configuration parser, Service orchestration, submission semantics 또는 Job lifecycle을 만들지 않는다.
- smoke는 루트 `.env`를 입력으로 저장소 내부의 격리된 XDG 환경을 준비한다.
- 기존 config loader가 그대로 동작할 수 있도록 smoke 환경을 구성하며, production config 탐색 규칙 자체는 변경하지 않는다.
- config, browser profile, discovery, locks, telemetry는 하나의 저장소 내부 smoke runtime에 속해야 한다.
- detached Service와 child process도 같은 smoke runtime을 상속해야 한다.
- smoke prompt는 실제 submission 여부와 Job readback을 확인하기 위한 최소한의 고정된 probe로 유지한다. 제품 기능 테스트 시나리오를 smoke에 축적하지 않는다.
- smoke가 시작한 Service와 runtime lifecycle은 smoke 진입점이 관리한다. 기존에 실행 중인 일반 사용자 Service를 제어 대상으로 삼지 않는다.
- browser authentication은 기존 방식과 retained profile을 사용하고 로그인 자동화를 추가하지 않는다.
- 현재 Notion Invocation lifecycle, acknowledgement semantics, HTTP authentication, browser interaction 및 Job read 계약은 보호 범위다.
- 일반 CLI의 XDG configuration과 `config` command 의미는 보호 범위다.
- 제품 workflow 수준의 추가 시나리오 검증이 필요하면 smoke에 누적하지 않고 별도 E2E 계획으로 다룬다.

## Verification

- 프로젝트 루트의 실제 `.env`가 존재하는 상태에서 smoke 진입점 하나만 실행한다.
- 사용자 XDG `chatgpt-shot` configuration과 runtime이 없어도 smoke가 저장소 내부 환경을 사용해 시작되는지 확인한다.
- smoke가 실제 Service를 시작하거나 기존 smoke Service를 찾아 readiness를 확인하는지 관찰한다.
- 실제 browser를 통해 고정 smoke prompt를 제출한다.
- 실제 Notion remote acceptance 후 production `submit` 계약에서 생성된 Job UUID를 얻는지 확인한다.
- 동일 smoke 환경에서 기존 Job read 경로를 사용해 해당 UUID의 durable Job을 읽는지 확인한다.
- 이 모든 단계가 성공한 경우에만 smoke가 성공 종료하는지 확인한다.
- 같은 저장소에 `.env`와 smoke runtime이 존재하더라도 일반 `chatgpt-shot config path`가 기존 사용자 XDG 경로를 계속 가리키는지 확인한다.
- smoke 실행 전후 사용자 XDG `chatgpt-shot` 상태가 smoke에 의해 생성되거나 변경되지 않았는지 확인한다.
- `.env`와 smoke runtime 전체가 Git 비추적 상태인지 확인한다.
- 누락된 `.env`, 잘못된 config, browser readiness 실패, submission 실패, acceptance 실패 및 Job read 실패가 각각 smoke 성공으로 오인되지 않는지 확인한다.
- 기존 automated tests를 실행하여 일반 configuration, CLI 및 Service 계약에 회귀가 없음을 확인한다.

## Verification Tools

- **Smoke 진입점**: 실제 configuration부터 submission과 Job readback까지 전체 smoke lifecycle을 실행한다.
- **기존 `chatgpt-shot` CLI**: smoke 내부의 production command surface로 사용한다.
- **기존 Service**: 실제 submission과 Job read execution을 담당한다.
- **실제 browser/ChatGPT Web**: production browser interaction이 동작하는지 확인한다.
- **실제 Notion Invocation**: remote acceptance와 durable Job의 authoritative outcome을 제공한다.
- **filesystem/Git 관찰**: smoke runtime 격리와 비밀값 비추적 경계를 확인한다.
- **기존 automated test suite**: 일반 실행 계약의 회귀를 확인한다.
