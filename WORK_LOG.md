# 치킨 프로젝트 작업 로그

> 세션·작업자가 바뀌어도 이 파일 하나로 현황 파악 가능.  
> 완료 항목은 지우지 않고 누적 기록. 남은 작업은 우선순위 순.

---

## 2026-06-05 (세션 1~2)

### ✅ 완료

#### 서버 (NestJS / Render.com)
- Neon.tech PostgreSQL 연결 완료
- Upstash Redis 연결 완료 (ECONNRESET 해결)
- NestJS 빌드 및 Render.com 배포 완료
  - URL: `https://chicken-order-system.onrender.com`
- Socket.IO OrderGateway 구현 (`new_order`, `order_updated` emit)
- BBQ 앱 호환 API 구현
  - `GET /health`, `POST /order`, `GET /orders`, `GET /menus`, `GET /settings`
- `areas` 테이블 + `GET /areas`, `GET /areas/:id` API
- DB 시드 데이터: stores(강남점/홍대점), menus(후라이드/양념/간장), areas(남동구/홍대/합정)
- 하드코딩 DB 자격증명 제거 (보안 패치, `migrate-005.js` / `migrate-areas.js`)
- `migrate-005.js` / `migrate-areas.js` 한국어 인코딩 수정 (BOM 제거)
- `socket.io-client` devDependency 추가 (e2e 테스트용)

#### Flutter 환경
- Flutter 3.44.1 설치 완료 (`C:\flutter`)
- Visual Studio Community 2026 설치 완료 (C++ 데스크톱 개발 워크로드)
- Developer Mode 활성화

#### POS Windows 빌드
- `bbqpos_like` Windows 빌드 성공
  - 결과물: `bbq_project\bbqpos_like\build\windows\x64\runner\Release\`
  - 빌드 과정에서 해결한 문제:
    1. 한국어 경로 → junction(`C:\posapp`) 우회
    2. VS 2026 `<experimental/coroutine>` 호환 → `windows/CMakeLists.txt`에 `_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS` 추가
  - API_KEY: `bbq_ics_api_2026` (dart-define 주입)
  - 서버 URL: `https://chicken-order-system.onrender.com` (AppConfig.dart 하드코딩)

---

### ⏳ 남은 작업 (우선순위 순)

#### 1. POS 배포 — 가게 PC에 복사 (즉시 가능)
- `Release` 폴더 전체를 가게 PC에 복사 (`exe` 단독 실행 불가, 폴더 통째로 필요)
- 경로: `bbq_project\bbqpos_like\build\windows\x64\runner\Release\`
- 가게 PC에서 실행 후 서버 URL / storeId 설정 확인

#### 2. 주문앱 Android APK 빌드 (Android SDK 설치 필요)
- Android Studio 또는 CLI SDK 설치 필요
- 빌드 명령:
  ```powershell
  cd "C:\치킨 프로젝트\bbq_project\bbq_order_app"
  flutter pub get
  flutter build apk --release
  ```
- 결과물: `build\app\outputs\flutter-apk\app-release.apk`

#### 3. 실제 매장 데이터 입력
- DB `areas` 테이블에 실제 지역명 INSERT
- DB `stores` 테이블에 실제 매장 추가 (현재: 강남점/홍대점 시드만)
- 메뉴 데이터 실제 메뉴로 교체

#### 4. end-to-end 운영 테스트
- 주문앱 → 서버 → POS 수신 흐름 실 기기 테스트
- Socket.IO `join_store` / `new_order` 소켓 연결 확인
- 주문 상태 변경 (ACCEPTED → COOKING → DONE) POS에서 확인

#### 5. Android SDK 설치 (APK 빌드 전제)
- 설치 방법: Android Studio 설치 or `flutter doctor` 안내 따라 SDK 설치
- 설치 후 `flutter doctor` 재확인

---

## 2026-06-10 (전수감사 버그 수정 세션)

### ✅ 완료

#### 전수감사 버그 수정 (CRITICAL → LOW 우선순위 순)

**[C-1] CRITICAL: orders.updated_at 컬럼 추가**
- `database/migrations/006_add_updated_at.sql` 생성
  - `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
  - 기존 행은 timestamp 컬럼(failed_at/completed_at/sent_to_pos_at/saved_at/queued_at) 중 가장 최신값으로 백필
- `scripts/migrate-006.js` 생성
- **실행 필요**: `DATABASE_URL=... node scripts/migrate-006.js`
- 영향 수정 불필요: `order.controller.ts:52`, `public.controller.ts:89,179` 쿼리는 이미 correct

**[C-2] CRITICAL: /menus URL storeId 누락 수정**
- `bbq_project/bbq_order_app/lib/services/api_service.dart:19`
  - `menusUri` → `?storeId=${AppConstants.storeId}&app=order` 추가
- `bbq_project/bbq_order_app/lib/screens/home_screen.dart:270,272`
  - `fetchMenus()` URL 동일하게 수정

**[H-1] HIGH: failure_reason 저장 조건 수정**
- `src/order/infrastructure/repositories/order.repository.ts:155`
  - `if (params.reason?.includes('FAILED'))` → `if (params.reason)` 수정
  - 이전: 실패 사유 텍스트에 'FAILED' 포함 시만 저장 → 대부분 누락
  - 이후: reason 값이 있으면 항상 저장

**[H-3] HIGH: Flutter 앱이 호출하는 누락 엔드포인트 추가 (stub)**
- `src/common/public.controller.ts`에 추가:
  - `GET /banners` → `{ ok: true, banners: [] }`
  - `GET /splash/:target` → `{ ok: true, imageUrl: null }`
  - `GET /customers/check` → `{ ok: true, exists: false }`
  - `GET /delivery-fee` → `{ ok: true, fee: 2000 }`
- 이전: 404 → 앱 silent fail

**[H-4] HIGH: createOrderCompat 입력 검증 추가**
- `src/common/public.controller.ts`의 `POST /order` 핸들러
  - `storeId` 빈 문자열 → 400-like `{ ok: false, message }` 반환
  - `total <= 0` → 400-like `{ ok: false, message }` 반환

**[M-1] MEDIUM: DLQ 이동 조건 수정 (재시도 횟수)**
- `src/order/application/process-order.service.ts:184`
  - `jobMeta.attemptsMade >= 3` → `>= 2` 수정
  - BullMQ `attemptsMade`는 0부터 시작 → >= 3이면 총 4회 시도
  - 수정 후: 총 3회 시도 후 DLQ 이동

**[M-4] MEDIUM: mapStatus POS 상태 명시적 매핑 추가**
- `src/common/public.controller.ts`의 `mapStatus()`
  - `ACCEPTED → 'ACCEPTED'`, `COOKING → 'ACCEPTED'`
  - `DONE → 'DONE'`, `CANCELLED → 'CANCELLED'` 명시적 추가
  - 이전: POS 상태가 `?? status` fallthrough로 그대로 반환

**[L-4] LOW: migration:run npm 스크립트 제거**
- `package.json`에서 `migration:run`, `migration:revert` 제거
  - 참조 파일 `src/database/data-source.ts` 존재하지 않음
  - 이 프로젝트는 raw SQL + `scripts/migrate-N.js` 방식 사용

#### 처리 불가 (기록)
- **[H-2]**: `checkout_screen.dart` dead code — 외부에서 진입 경로 없으므로 harmless. 방치.
- **[M-2]**: POS 엔드포인트 URL 미확인 (실제 운영 서버 URL 불명) — skip
- **[M-3]**: `order_status_outbox` dead table — 사용 안 됨. 방치.
- **[L-1]**: POS 프린터 스크립트 경로 (`app_config.dart`) — 치킨 프로젝트의 실제 경로 미확정. skip
- **[L-2]**: `home_screen.dart` 하드코딩 매장명 — 실 매장 데이터 입력 시점에 수정
- **[L-3]**: Socket.IO CORS wildcard — 현재 개발 단계 허용

---

## 2026-06-10 (세션)

### ✅ 완료

#### AWS 과금 사고 처리
- AWS Budget 알림 수신: $110.14 과금 (Zero-Spend 초과)
- 원인 파악: CDK 스택 5/29 배포 후 6/8까지 10일 실행
  - RDS r7g.xlarge Multi-AZ + Read Replica: $58.98
  - ElastiCache r7g.large ×2: $21.44
  - ECS Fargate: $9.73
  - NAT Gateway 3개 등: $6.90 + $1.71 + $1.34
  - Tax: $10.00
- 현재 상태: 모든 리소스 6/8 삭제 완료, 추가 과금 없음
- AWS Support 크레딧 요청 완료 (케이스 번호: 178093404500592)
- 기다리는 중

---

## 주요 설정값 (빠른 참조)

| 항목 | 값 |
|------|-----|
| 서버 URL | `https://chicken-order-system.onrender.com` |
| DB | Neon.tech PostgreSQL (connection string: `.env` 참조) |
| Redis | Upstash (`.env` 참조) |
| API Key | `bbq_ics_api_2026` |
| Flutter 경로 | `C:\flutter` |
| POS 앱 경로 | `C:\치킨 프로젝트\bbq_project\bbqpos_like\` |
| 주문앱 경로 | `C:\치킨 프로젝트\bbq_project\bbq_order_app\` |
| POS 빌드 결과물 | `bbqpos_like\build\windows\x64\runner\Release\` |

---

## Windows 빌드 시 주의사항

- **한국어 경로 문제**: `flutter build windows`는 한국어 경로에서 MSBuild 인코딩 오류 발생
  - 해결: `cmd /c "mklink /J C:\posapp ""C:\치킨 프로젝트\bbq_project\bbqpos_like"""` 후 `C:\posapp`에서 빌드
- **VS 2026 호환**: `windows/CMakeLists.txt`에 이미 `_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS` 추가됨 (재빌드 시 불필요)
- **Developer Mode**: Windows 설정 > 개발자용 > 개발자 모드 ON 필요
