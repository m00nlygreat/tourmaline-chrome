# Tourmaline Chrome 포팅 계획

## 개요

이 문서는 Tourmaline을 Obsidian 플러그인에서 Chrome 확장프로그램으로 포팅하기 위한 계획을 정리한다.

현재 코드베이스는 아직 Obsidian 플러그인 구조를 중심으로 작성되어 있다. 다만 핵심 캔버스 경험은 이미 구현되어 있다. Markdown 문서를 scope, section, orphan block, embed, layer row, layout metadata로 해석하고, 이를 확대/축소 가능한 캔버스에 배치하는 모델이 존재한다.

Chrome 포팅의 핵심은 이 제품 모델을 유지하면서 Obsidian 런타임에 의존하는 부분을 브라우저와 확장프로그램 런타임에 맞는 서비스로 교체하는 것이다.

따라서 이 작업은 단순히 `manifest.json`을 Chrome 형식으로 바꾸는 일이 아니라, 플랫폼 의존성을 분리하는 작업으로 다룬다.

## 포팅 목표

Tourmaline의 Chrome 확장프로그램 버전은 Markdown 파일을 여는 editor이자 viewer여야 한다. 사용자는 Markdown 원본을 편집하면서 동시에 Tourmaline 캔버스 프리뷰를 실시간으로 확인할 수 있어야 한다.

초기 목표 기능은 다음과 같다.

- Markdown 구조를 캔버스 항목으로 변환
- Markdown 원본 편집과 캔버스 프리뷰의 실시간 동기화
- 로컬 파일 시스템의 `.md` 파일 열기
- 확대, 축소, 패닝 가능한 캔버스
- section 카드와 orphan 카드 렌더링
- layer panel 탐색
- 카드 위치와 크기 같은 layout metadata 저장
- 브라우저 환경에 맞는 Markdown 렌더링

첫 Chrome 버전이 곧바로 Obsidian 플러그인과 완전한 기능 동등성을 가질 필요는 없다. 먼저 안정적인 확장프로그램 아키텍처를 만들고, 기능을 단계적으로 옮길 수 있는 기반을 만드는 것을 목표로 한다.

## 확정된 방향

현재 확정된 Chrome 포팅 방향은 다음과 같다.

- Tourmaline Chrome은 Markdown editor와 viewer를 함께 제공한다.
- Chrome 버전의 기본 화면은 popup이나 content overlay가 아니라 독립 extension page로 둔다.
- Obsidian Zoom 플러그인 기능은 사용하지 않는다.
- Zoom 플러그인이 제공하던 source focus 경험은 Chrome 버전에서 실시간 편집 프리뷰로 대체한다.
- 로컬 파일 시스템에서 `.md` 파일을 열 수 있어야 한다.
- Layout metadata는 Chrome 확장프로그램의 IndexedDB에 저장한다.
- Layout metadata는 파일 단위 document identity에 묶고, 파일 내부 항목은 node id, heading path, line fallback으로 식별한다.
- Document identity는 FileSystemFileHandle을 우선 사용하고, 보조 식별자로 파일명, 크기, 수정시각, content hash를 함께 저장한다.
- 이미지 embed 경로는 현재 Markdown 파일 위치를 기준으로 해석한다.
- `https://`, `http://`, `data:` 같은 global URL 이미지도 사용할 수 있게 한다.
- 이미지 embed는 경로를 읽을 수 있는 경우 실제 이미지를 불러와 표시한다.
- Obsidian 파일 embed는 대상 파일을 직접 펼치지 않고 embed pill 형태로만 표현한다.
- `/tourmaline` 하위의 기존 Obsidian 플러그인은 참고용으로만 사용하고, Chrome 포팅 중 build compatibility 유지 대상으로 보지 않는다.

## 현재 상태

현재 `/tourmaline` 하위 프로젝트는 Obsidian 플러그인으로 빌드되는 참고 코드이다. Chrome 포팅 작업은 프로젝트 루트에서 진행하고, `/tourmaline` 하위 파일은 포팅 참고 자료로만 사용한다.

주요 구성은 다음과 같다.

- `main.ts`: Obsidian 플러그인 진입점. command, ribbon icon, custom view를 등록한다.
- `src/view.ts`: Tourmaline 화면의 대부분의 런타임 동작과 UI 조립을 담당한다.
- `src/domain.ts`: Markdown 구조 파싱, scope 생성, item label, layout helper, DOM helper를 포함한다.
- `src/source-transforms.ts`: Markdown 원본을 변경하는 순수 text transform과 Obsidian vault 적용 서비스를 포함한다.
- `src/meta-store.ts`: Obsidian vault를 통해 `.meta.json` layout metadata를 읽고 쓴다.
- `src/card-renderer.ts`, `src/layer-panel.ts`, `src/grid-renderer.ts`, `src/viewport-controller.ts`: 비교적 브라우저로 옮기기 쉬운 UI 및 interaction 모듈이다.
- Vitest 기반 테스트가 일부 순수 로직을 검증하고 있으며 현재 통과한다.

Chrome 포팅에서 교체해야 할 주요 Obsidian 의존성은 다음과 같다.

- plugin lifecycle: `Plugin`, `ItemView`, `WorkspaceLeaf`
- file access: `TFile`, `Vault`, metadata cache
- Markdown preview: `MarkdownRenderer`
- workspace navigation과 source open 동작
- `Notice`와 `setIcon`
- `createDiv`, `empty`, `toggleClass`, `addClass` 같은 Obsidian DOM prototype helper
- Obsidian wiki link, embed, frontmatter, subpath 처리 유틸리티

## 포팅 전략

가장 안전한 방향은 코드베이스를 host-independent core와 host-specific adapter로 나누는 것이다.

목표 계층은 다음과 같다.

- Core domain: Markdown 파싱, scope 생성, source transform, layout metadata 구조, selection state, viewport math
- UI components: canvas, card, layer panel, grid, toolbar, interaction
- Host adapter: local file access, Markdown rendering, persistence, link resolution, notification, icon rendering, source editing
- Extension shell: Manifest V3 entry point, extension page, side panel 또는 popup, background service worker, storage permission

Chrome 포팅은 `/tourmaline`의 기존 Obsidian 플러그인 코드를 참고하되, 새 확장프로그램 런타임을 루트 프로젝트에서 독립적으로 만든다. 기존 Obsidian 플러그인과의 동시 빌드 호환성은 1차 포팅 목표에 포함하지 않는다.

## 초기 마일스톤

1. Obsidian 전용 API 사용 지점을 조사하고 목록화한다.
2. 순수 로직과 host 의존 로직의 경계를 정한다.
3. host-neutral interface를 정의하고 portable module부터 분리한다.
4. Obsidian DOM helper 사용을 로컬 DOM utility로 교체한다.
5. 브라우저용 Markdown renderer 경로를 추가한다.
6. Manifest V3 기반 Chrome extension scaffold를 만든다.
7. Markdown editor와 canvas preview가 함께 있는 최소 extension page를 구현한다.
8. sample Markdown과 로컬 `.md` 파일을 열 수 있게 한다.
9. pan, zoom, select, drag, resize가 브라우저에서 동작하게 한다.
10. 이미지 embed와 파일 embed pill 표현을 분리한다.
11. layout metadata를 IndexedDB에 저장한다.
12. metadata를 document identity와 파일 내부 node identity에 연결한다.

## 1차 초안 범위

첫 포팅 초안은 작지만 실제로 동작하는 Markdown editor와 브라우저 캔버스를 목표로 한다.

포함 범위:

- 하나의 Markdown 문자열을 로드
- 로컬 파일 시스템에서 `.md` 파일 열기
- Markdown 원본을 편집하는 editor 영역
- 편집 내용이 캔버스 preview에 실시간 반영되는 동기화
- 기존 구조 규칙으로 Markdown 파싱
- Chrome extension page에서 card와 layer panel 렌더링
- pan, zoom, select, drag, resize 지원
- 현재 Markdown 파일 위치 기준 이미지 embed 렌더링
- global URL 이미지 embed 렌더링
- Obsidian 파일 embed의 pill 형태 렌더링
- layout metadata를 IndexedDB에 저장

제외 범위:

- `/tourmaline` 하위 Obsidian 플러그인 수정
- Obsidian 플러그인 build compatibility 유지
- Obsidian popout 또는 Zoom plugin 동작
- Obsidian식 section-focused source open 동작
- vault 전체 embed resolution
- 기존 Obsidian metadata의 완전한 migration
- production-ready content script 동작
