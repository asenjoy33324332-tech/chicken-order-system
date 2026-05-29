# 차세대 프랜차이즈 통합 주문 시스템

프랜차이즈 브랜드의 200개 이상 매장에서 발생하는 주문을 수집·검증·전달하는 **백엔드 미들웨어**입니다.  
동시 접속자 500명 환경에서 **주문 유실 0건 / 중복 처리 0건**을 목표로 설계되었습니다.

---

## 성능 지표 (k6 부하 테스트, 4분)

| 시나리오 | p95 | p99 | 에러율 | 처리량 |
|---|---|---|---|---|
| CCU 300 정상 부하 | 131ms | 144ms | **0%** | — |
| CCU 500 스파이크 | — | 314ms | **0%** | **1,204 req/s** |

---

## 시스템 아키텍처

```
                         ┌─────────────────────────────────────────────────┐
  손님 앱 / POS 연동      │                  AWS ECS Fargate                 │
                         │                                                  │
  POST /api/v1/orders    │  ┌──────────────┐      ┌──────────────────────┐ │
──────────────────────▶  │  │  API Server  │      │   Worker Server      │ │
                         │  │              │      │                      │ │
                         │  │ ① 멱등성 체크 │      │ ③ 분산 락 획득       │ │
                         │  │   (Redis)    │      │ ④ DB INSERT (QUEUED) │ │
                         │  │ ② BullMQ 적재│      │ ⑤ POS 전송           │ │
                         │  └──────┬───────┘      │ ⑥ COMPLETED 전이     │ │
                         │         │              └──────────┬───────────┘ │
                         └─────────┼───────────────────────┼───────────────┘
                                   │                        │
                    ┌──────────────┴──────────┐             │
                    │      ElastiCache Redis  │◀────────────┘
                    │  • 멱등성 키 (24h TTL)  │
                    │  • 분산 락 (60s TTL)    │
                    │  • BullMQ 브로커        │
                    └─────────────────────────┘

                    ┌─────────────────────────┐
                    │   RDS PostgreSQL 15      │
                    │  • orders (UNIQUE key)   │
                    │  • order_items           │
                    │  • order_state_transitions│
                    └─────────────────────────┘
```

### 3중 중복 방지 설계

```
요청 수신
   │
   ▼
① Redis SETNX (멱등성 키)     ← 1선: 동일 요청 즉시 차단 (O(1))
   │
   ▼
② DB UNIQUE 제약              ← 2선: Redis 장애 시에도 DB 레벨에서 차단
   │
   ▼
③ 분산 락 (Redis)             ← 3선: 동일 orderId 동시 처리 방지
```

---

## 기술 스택

| 분류 | 기술 |
|---|---|
| 언어 / 프레임워크 | TypeScript, NestJS 10 |
| 데이터베이스 | PostgreSQL 15 (AWS RDS) |
| 캐시 / 큐 브로커 | Redis 7.1 (AWS ElastiCache) |
| 큐 라이브러리 | BullMQ |
| ORM | TypeORM |
| 로깅 | pino (structured JSON) |
| 수치 계산 | decimal.js (부동소수점 오차 방지) |
| 인프라 | AWS ECS Fargate, ALB, Secrets Manager |
| IaC | AWS CDK (TypeScript) |
| CI/CD | GitHub Actions |

---

## 주요 기능

### 주문 처리 파이프라인
- **비동기 큐 기반 처리**: API 서버는 검증 후 즉시 `202 Accepted` 반환, Worker가 순차 처리
- **금액 교차 검증**: 클라이언트 요청 금액 vs 서버 계산 금액 불일치 시 거부
- **상태 머신**: `QUEUED → SAVED → SENT_TO_POS → COMPLETED` 단방향 전이 강제

### 안정성
- **서킷 브레이커**: POS 장애 시 5회 실패 후 30초 Open 상태 전환, 전체 시스템 보호
- **지수 백오프 재시도**: 최대 3회, 기본 지연 1초
- **DLQ (Dead Letter Queue)**: 최종 실패 주문 별도 관리 + Slack 알림
- **수동 재처리 API**: 관리자가 FAILED 주문을 QUEUED로 되돌려 재처리

### POS 연동
- **어댑터 패턴**: LEGACY_V1 (XML), MODERN_V2/TABLET_V3 (REST JSON) 통합 인터페이스
- **멱등성 헤더 전달**: `X-Idempotency-Key`로 POS 측 중복 수신도 방어

---

## API 엔드포인트

### 주문 API

```
POST /api/v1/orders
```

**요청 헤더**
```
Idempotency-Key: <클라이언트 생성 UUID>
```

**요청 바디**
```json
{
  "idempotencyKey": "uuid-v4",
  "storeId": "11111111-1111-1111-1111-111111111111",
  "userId": "user-uuid",
  "totalAmount": "37000",
  "items": [
    { "menuId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "quantity": 2 }
  ]
}
```

**응답 (202 Accepted)**
```json
{
  "orderId": "uuid-v4",
  "traceId": "uuid-v4",
  "status": "QUEUED"
}
```

### 관리자 API

```
GET  /admin/health                    # 헬스체크
GET  /admin/orders/dlq                # DLQ 목록 조회
POST /admin/orders/:orderId/redrive   # 주문 수동 재처리
GET  /admin/system/status             # 큐 깊이 + 서킷 브레이커 현황
```

---

## 주문 상태 흐름

```
                  ┌─────────┐
  수신 즉시 ──▶   │ QUEUED  │
                  └────┬────┘
                       │ Worker 처리 시작
                  ┌────▼────┐
                  │  SAVED  │  ← DB 저장 완료
                  └────┬────┘
                       │ POS 전송
                  ┌────▼──────────┐
                  │ SENT_TO_POS   │
                  └────┬──────────┘
                       │ POS 응답 수신
                  ┌────▼──────────┐
                  │   COMPLETED   │  (종단 상태)
                  └───────────────┘

  * 모든 단계에서 오류 발생 시 → FAILED (종단 상태)
  * 관리자 재처리: FAILED → QUEUED (isAdminRedrive 플래그)
```

---

## 프로젝트 구조

```
src/
├── common/
│   ├── filters/          # 전역 예외 필터
│   ├── interceptors/     # traceId 주입 인터셉터
│   ├── logger/           # pino structured logger
│   └── trace/            # AsyncLocalStorage 기반 trace context
│
├── config/               # 환경 변수 설정
│
├── order/
│   ├── api/              # HTTP 컨트롤러, DTO
│   ├── application/      # 유스케이스 (create-order, process-order)
│   ├── domain/           # 엔티티, 상태 머신, 에러 정의
│   ├── infrastructure/
│   │   ├── idempotency/  # Redis 멱등성 서비스
│   │   ├── lock/         # 분산 락 서비스
│   │   ├── pos/          # POS 어댑터 (Legacy V1, Modern V2), 서킷 브레이커
│   │   ├── queue/        # BullMQ 서비스
│   │   └── repositories/ # TypeORM 리포지토리
│   └── worker/           # BullMQ 프로세서 (main queue, DLQ)
│
├── admin/                # 관리자 API
├── notification/         # Slack 알림
│
├── app-api.module.ts     # API 서버 모드
├── app-worker.module.ts  # Worker 서버 모드
└── main.ts               # APP_MODE로 모드 분기

infra/                    # AWS CDK (TypeScript)
├── bin/app.ts
└── lib/
    ├── network-stack.ts  # VPC, 서브넷, NAT Gateway
    ├── data-stack.ts     # RDS, ElastiCache
    ├── ecs-stack.ts      # ECS 클러스터, ALB, 서비스, Auto-scaling
    ├── ecr-stack.ts      # ECR 레포지토리
    └── iam-stack.ts      # GitHub Actions OIDC Role

database/
└── migrations/
    └── 001_initial_schema.sql
```

---

## 환경 변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `APP_MODE` | 실행 모드 (`api` / `worker` / `all`) | `all` |
| `DATABASE_HOST` | PostgreSQL 호스트 | `localhost` |
| `DATABASE_PORT` | PostgreSQL 포트 | `5432` |
| `DATABASE_USER` | DB 사용자 | `orderuser` |
| `DATABASE_PASSWORD` | DB 비밀번호 | — |
| `DATABASE_NAME` | DB 이름 | `orderdb` |
| `REDIS_HOST` | Redis 호스트 | `localhost` |
| `REDIS_PORT` | Redis 포트 | `6379` |
| `DB_POOL_MAX` | DB 커넥션 풀 최대값 | `5` |
| `MAX_RETRY_ATTEMPTS` | BullMQ 재시도 횟수 | `3` |
| `RETRY_BASE_DELAY_MS` | 재시도 기본 지연 (ms) | `1000` |
| `CB_FAILURE_THRESHOLD` | 서킷 브레이커 임계값 | `5` |
| `CB_OPEN_DURATION_MS` | 서킷 브레이커 Open 지속 시간 (ms) | `30000` |
| `LOCK_TTL_SECONDS` | 분산 락 TTL | `60` |
| `IDEMPOTENCY_TTL_SECONDS` | 멱등성 키 TTL | `86400` |
| `ADMIN_BASE_URL` | 관리자 대시보드 기본 URL | `http://localhost:3000` |
| `SLACK_WEBHOOK_URL` | Slack 알림 Webhook (선택) | — |

---

## 로컬 실행

```bash
# 의존성 설치
npm install

# PostgreSQL + Redis (Docker)
docker run -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=orderpass \
  -e POSTGRES_USER=orderuser \
  -e POSTGRES_DB=orderdb \
  postgres:15

docker run -d -p 6379:6379 redis:7

# DB 마이그레이션
psql -h localhost -U orderuser -d orderdb \
  -f database/migrations/001_initial_schema.sql

# 실행 (API + Worker 통합 모드)
npm run start:dev
```

---

## AWS 인프라

### Staging

| 리소스 | 사양 |
|---|---|
| RDS PostgreSQL | db.t4g.micro, 단일 AZ |
| ElastiCache Redis | cache.t3.micro, 노드 1개 |
| ECS API | 0.5 vCPU / 1GB, desiredCount=1 |
| ECS Worker | 1 vCPU / 2GB, desiredCount=1 |

### Production

| 리소스 | 사양 |
|---|---|
| RDS PostgreSQL | db.r7g.xlarge, Multi-AZ + Read Replica |
| ElastiCache Redis | cache.r7g.large, Multi-AZ (Primary + Replica) |
| ECS API | 0.5 vCPU / 1GB, desiredCount=2, Auto-scaling (max 20) |
| ECS Worker | 1 vCPU / 2GB, desiredCount=2, Auto-scaling (max 30) |

### CDK 배포

```bash
cd infra && npm install

export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=ap-northeast-2

# Staging
npx cdk deploy OrderSystem-Staging-Network OrderSystem-Staging-Data OrderSystem-Staging-ECS

# Production
npx cdk deploy OrderSystem-Prod-Network OrderSystem-Prod-Data OrderSystem-Prod-ECS
```

---

## CI/CD 파이프라인

```
staging 브랜치 push
    └─▶ CI (tsc --noEmit)
    └─▶ Deploy — Staging
          └─▶ Docker build & push (ECR :staging)
          └─▶ ECS 롤링 배포

master 브랜치 push
    └─▶ CI
    └─▶ Deploy — Production
          └─▶ Docker build & push (ECR :latest, :v-{SHA})
          └─▶ ECS 롤링 배포
```

**필요한 GitHub Secrets**

| Secret | 설명 |
|---|---|
| `AWS_ROLE_ARN` | GitHub Actions OIDC Role ARN |
| `AWS_REGION` | `ap-northeast-2` |
| `ECR_REPOSITORY` | ECR 레포지토리 이름 |
| `ECS_CLUSTER_STAGING` | Staging ECS 클러스터 이름 |
| `ECS_SERVICE_API_STAGING` | Staging API 서비스 이름 |
| `ECS_SERVICE_WORKER_STAGING` | Staging Worker 서비스 이름 |
| `ECS_CLUSTER_PRODUCTION` | Production ECS 클러스터 이름 |
| `ECS_SERVICE_API_PRODUCTION` | Production API 서비스 이름 |
| `ECS_SERVICE_WORKER_PRODUCTION` | Production Worker 서비스 이름 |
| `SLACK_WEBHOOK_URL` | Slack 알림 Webhook (선택) |
