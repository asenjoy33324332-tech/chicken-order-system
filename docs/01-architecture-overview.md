# 01. 전체 아키텍처 설계

## 1. 시스템 컴포넌트 구성

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              클라이언트 레이어                                  │
│   [모바일 앱]        [테이블 오더]        [매장 POS 단말기]                       │
└──────────────┬──────────────────┬──────────────────┬──────────────────────────┘
               │                  │                  │
               └──────────────────┼──────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           인프라 레이어                                         │
│              [AWS ALB / CloudFront]  ←  DDoS 방어, SSL 종단                    │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        API 서버 클러스터 (NestJS, Stateless)                    │
│                                                                               │
│  ① traceId 발급 → ② JWT 검증 → ③ 스키마 검증 → ④ 멱등성 검증 (Redis)           │
│  → ⑤ 금액 교차 검증 (DB Read Only) → ⑥ BullMQ 적재 → ⑦ HTTP 202 응답         │
│                                                                               │
│  [API Pod #1]  [API Pod #2]  [API Pod #N]   ← Horizontal Scale                │
└──────────┬────────────────────────────┬──────────────────────────────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────┐    ┌────────────────────────────────────────────────────┐
│  Redis Cluster      │    │  PostgreSQL (Primary + Read Replica)               │
│                     │    │                                                    │
│  • idempotency_key  │    │  [API 서버] → READ ONLY (메뉴 단가 조회)             │
│  • dist_lock        │    │  [Worker]  → READ/WRITE (주문 영속화)               │
│  • circ_breaker     │    │                                                    │
│  • BullMQ Queue     │    └────────────────────────────────────────────────────┘
└─────────────────────┘                 ▲
           │                            │
           ▼                            │
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Worker 서버 클러스터 (NestJS)                            │
│                                                                               │
│  ① BullMQ job 수신 → ② 분산 락 획득 → ③ 상태 머신 검증 → ④ DB 영속화           │
│  → ⑤ POS 연동 (ACL + Circuit Breaker) → ⑥ 상태 전이 완료 → ⑦ 락 해제         │
│                                                                               │
│  [Worker Pod #1]  [Worker Pod #2]  [Worker Pod #N]                           │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                 [POS 매장 #1]  [POS 매장 #2]  [POS 매장 #N]
                 (Circuit Breaker per store)
```

---

## 2. API 서버 처리 흐름 (완전한 책임 정의)

### 2.1 Happy Path

```
클라이언트 요청 (POST /api/v1/orders)
│
▼ [Step 1] traceId 발급
│  UUID v4 생성. 이후 모든 로그에 이 값이 포함됨.
│  이 시점부터 요청 처리 실패 시에도 traceId는 응답에 포함.
│
▼ [Step 2] 인증 검증 (JWT / API Key)
│  실패 시: HTTP 401. traceId 포함하여 응답.
│
▼ [Step 3] 요청 스키마 검증 (class-validator)
│  실패 시: HTTP 400. 어떤 필드가 왜 잘못됐는지 명시.
│
▼ [Step 4] 멱등성 키 검증 (Redis SETNX)
│  Redis 명령: SET idempotency:{idempotencyKey} "pending:{orderId}" NX EX 86400
│  - NX: 키가 없을 때만 설정 (원자적)
│  - EX 86400: 24시간 후 자동 만료 (스토리지 누수 방지)
│  결과 A - 키 없음 → 새 요청, 계속 진행
│  결과 B - 키 있음 → 중복 요청
│    └─ 캐시된 응답 반환 (이전 성공 응답이면 그대로, 아직 처리 중이면 202 pending)
│
▼ [Step 5] 금액 교차 검증 (PostgreSQL Read Replica)
│  DB에서 요청된 각 menu_id의 현재 단가(unit_price)를 조회.
│  서버 측 총액 = Σ(unit_price × quantity)
│  요청 금액 vs 서버 계산 금액 비교.
│  불일치 시: HTTP 422 (금액 불일치). idempotency 키 삭제 후 응답.
│  ※ 이 검증이 API 레이어의 유일한 DB Read 작업.
│
▼ [Step 6] BullMQ 적재
│  Queue: orders:main
│  Payload: { orderId, traceId, storeId, userId, items, totalAmount,
│             calculatedAmount, idempotencyKey, requestedAt }
│  BullMQ 적재 실패 시: Redis에서 idempotency 키 삭제 후 HTTP 503 응답.
│  ※ 클라이언트가 재시도할 수 있도록 idempotency 키를 되돌림.
│
▼ [Step 7] HTTP 202 응답
   { orderId, traceId, status: "QUEUED", message: "주문이 접수되었습니다." }
```

### 2.2 API 서버가 DB Write를 하지 않는 이유 (설계 근거)

API 서버가 DB에 쓴다면 두 가지 문제가 발생한다:

1. **응답 속도 종속성**: API의 P99 레이턴시가 DB P99 레이턴시에 직접 종속됨. 피크 타임 DB 지연이 API 응답 지연으로 직결됨.
2. **분산 트랜잭션 위험**: API가 DB Write와 BullMQ 적재를 모두 수행하면, DB Write 성공 후 BullMQ 적재 실패 시 "DB에는 있지만 처리는 안 되는" 고아 레코드가 생김.

Redis SETNX → BullMQ 적재 순서는 원자성이 필요한 작업이지만, 두 연산 사이의 실패 시 **Redis 키만 삭제하면 되는 단순한 보상 로직**으로 처리된다. DB 롤백이 필요 없으므로 훨씬 안전하다.

---

## 3. Worker 서버 처리 흐름

```
BullMQ에서 job 수신 (orders:main)
│
▼ [Step 1] 분산 락 획득 시도
│  Redis 명령: SET lock:order:{orderId} {workerId}:{jobId} NX EX 60
│  - 성공: 락 획득, 처리 계속
│  - 실패: 다른 Worker가 처리 중. BullMQ에 지연 재시도 등록 후 종료.
│
▼ [Step 2] DB에서 중복 확인 (방어 2선)
│  SELECT id FROM orders WHERE idempotency_key = ? FOR UPDATE NOWAIT
│  - 레코드 없음: 새 주문, 계속
│  - 레코드 있음 (QUEUED 이상): 이미 처리됨. 락 해제 후 job 완료(ack).
│
▼ [Step 3] DB INSERT (status: QUEUED) + 트랜잭션 #1
│  BEGIN;
│  INSERT INTO orders (id, idempotency_key, store_id, ..., status, version)
│    VALUES (?, ?, ?, ..., 'QUEUED', 0)
│    ON CONFLICT (idempotency_key) DO NOTHING;
│  INSERT INTO order_items (...) VALUES (...);
│  INSERT INTO order_state_transitions (order_id, from_status, to_status)
│    VALUES (?, NULL, 'QUEUED');
│  COMMIT;
│  ※ 트랜잭션 범위를 INSERT 3개로 최소화 → Deadlock 위험 최소화
│
▼ [Step 4] 비즈니스 검증 (재고, 영업시간 등)
│  검증 실패 시: status → FAILED 처리, 분산 락 해제.
│
▼ [Step 5] DB UPDATE (status: SAVED) + 트랜잭션 #2
│  BEGIN;
│  UPDATE orders SET status = 'SAVED', saved_at = NOW(), version = version + 1
│    WHERE id = ? AND status = 'QUEUED' AND version = ?;
│  -- Optimistic Lock: version 불일치 시 0 rows → 예외 발생 → 재시도
│  INSERT INTO order_state_transitions VALUES (?, 'QUEUED', 'SAVED');
│  COMMIT;
│
▼ [Step 6] POS 연동 (ACL + Circuit Breaker)
│  Circuit Breaker 상태 확인 (매장별):
│  - CLOSED: POS API 호출
│  - OPEN: 즉시 실패 반환, 재시도 큐에 등록
│  - HALF_OPEN: 1회 프로브 허용
│
│  POS 호출 성공:
│    DB UPDATE: status SAVED → SENT_TO_POS → COMPLETED (트랜잭션 #3)
│  POS 호출 실패:
│    재시도 카운터 증가. 3회 이하: 지수 백오프 후 재시도.
│    3회 초과: orders:dlq로 이동, Slack 알림 트리거.
│
▼ [Step 7] 분산 락 해제
   DEL lock:order:{orderId}
   ※ finally 블록에서 반드시 실행 (예외 시에도 해제 보장)
```

---

## 4. 데이터 흐름 다이어그램

### 4.1 정상 흐름 (End-to-End)

```
Client          API Server      Redis           BullMQ          Worker          PostgreSQL      POS
  │                │               │               │               │               │              │
  │─POST /orders──▶│               │               │               │               │              │
  │                │─SETNX──────▶  │               │               │               │              │
  │                │◀──OK──────────│               │               │               │              │
  │                │─READ menus────────────────────────────────────────────────▶   │              │
  │                │◀──menu data───────────────────────────────────────────────────│              │
  │                │─PUBLISH───────────────────────▶               │               │              │
  │                │◀──job_id──────────────────────│               │               │              │
  │◀──202 Accepted─│               │               │               │               │              │
  │                │               │               │─CONSUME job──▶│               │              │
  │                │               │               │               │─SETNX lock────▶               │
  │                │               │               │               │◀──OK──────────│               │
  │                │               │               │               │─INSERT────────────────────▶   │
  │                │               │               │               │◀──OK──────────────────────────│
  │                │               │               │               │─UPDATE(SAVED)─────────────▶   │
  │                │               │               │               │─POS call──────────────────────────▶
  │                │               │               │               │◀──POS ACK─────────────────────────│
  │                │               │               │               │─UPDATE(DONE)──────────────▶   │
  │                │               │               │               │─DEL lock──────▶               │
```

### 4.2 POS 장애 흐름

```
Worker                  Redis (CircuitBreaker)      BullMQ:dlq      Slack
  │                              │                       │             │
  │─CB 상태 확인──────────────▶  │                       │             │
  │◀──OPEN (차단 중)─────────────│                       │             │
  │                              │                       │             │
  │ (재시도 3회 소진 후)          │                       │             │
  │─DLQ 이동─────────────────────────────────────────▶   │             │
  │─알림 트리거───────────────────────────────────────────────────────▶│
  │                              │                       │             │
  │ (30초 후 CB HALF-OPEN)        │                       │             │
  │─프로브 요청──────────────────────────────────────────────────────────▶POS
  │◀──성공──────────────────────────────────────────────────────────────│
  │─CB CLOSE 기록──────────────▶ │                       │             │
  │─DLQ에서 재처리────────────────────────────────────── ◀             │
```

---

## 5. 컴포넌트별 기술 스택 매핑

| 컴포넌트 | 기술 | 선택 근거 |
|---------|------|---------|
| API 서버 | NestJS + TypeScript | Guard/Interceptor 레이어로 횡단 관심사(traceId, 로깅) 분리 가능 |
| 메시지 큐 | BullMQ on Redis | 별도 MQ 인프라 불필요, Redis 재사용, 재시도/DLQ 내장 지원 |
| 분산 락 | ioredis + Redlock 알고리즘 | Redis의 SET NX EX 원자 명령 기반, 락 TTL로 Deadlock 자동 해소 |
| 메인 DB | PostgreSQL 15+ | FOR UPDATE SKIP LOCKED (큐 패턴), UNIQUE 제약, Optimistic Lock 완전 지원 |
| 서킷 브레이커 | cockatiel (NestJS 호환) | Exponential Backoff, Circuit Breaker, Timeout 등 분산 장애 패턴 라이브러리 |
| 로깅 | pino (JSON 구조화) | 고성능 비동기 로깅, JSON 네이티브 출력, AWS CloudWatch 직접 연동 가능 |
| 인프라 | AWS ECS Fargate | 서버 관리 불필요, 컨테이너 기반 Auto-scaling, VPC 완전 격리 |
