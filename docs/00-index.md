# 차세대 프랜차이즈 통합 주문 시스템 — 상세 설계서 (1차 산출물)

> **목적:** 개발 착수 전 제출하는 기술 설계 문서. 기능 설명이 아닌, **"왜 이 구조가 안전한가"를 증명**하는 형태로 작성.

---

## 문서 목록

| 문서 | 내용 |
|------|------|
| [01 아키텍처 개요](./01-architecture-overview.md) | 전체 시스템 구성, 컴포넌트 책임, 데이터 흐름 다이어그램 |
| [02 데이터 모델](./02-data-model.md) | DB 스키마 설계, 인덱스 전략, 제약 조건 근거 |
| [03 상태 머신](./03-state-machine.md) | 주문 상태 전이 정의, 역행 방지 구현 방식 |
| [04 동시성 제어](./04-concurrency-control.md) | Redis 분산 락, 멱등성 키, 낙관적 락 계층 설계 |
| [05 장애 대응](./05-fault-tolerance.md) | 서킷 브레이커, 재시도/DLQ, POS 격리 전략 |
| [06 옵저버빌리티](./06-observability.md) | traceId 기반 E2E 로그 추적, 구조화 로깅 설계 |
| [07 인프라 제안](./07-infra-proposal.md) | 클라우드 아키텍처, TCO 산출, Auto-scaling 정책 |

---

## 핵심 설계 원칙

이 시스템의 모든 설계 결정은 아래 5가지 원칙을 기반으로 정당화됩니다.

### 원칙 1: 장애는 정상 상태다 (Fault as Normal)
POS 단절, DB 지연, Worker 크래시는 예외가 아니라 상시 발생하는 정상 상태다. 장애 발생 시 전체 파이프라인이 멈추지 않고 **격리(Isolation) 후 자가 치유(Self-healing)**되어야 한다.

### 원칙 2: 멱등성은 다층 방어로만 보장된다 (Multi-layer Idempotency)
단일 Redis 체크나 단일 DB Unique 제약으로는 분산 환경에서 멱등성을 보장할 수 없다. API 레벨(Redis SETNX) → Worker 레벨(Distributed Lock) → DB 레벨(Unique Constraint) 3계층이 모두 존재해야 한다.

### 원칙 3: 상태 머신은 강제되어야 한다 (Enforced State Machine)
코드 컨벤션이나 주석으로 상태 전이를 "권고"하는 것은 의미 없다. DB 레벨의 CHECK 제약과 애플리케이션 레벨의 Optimistic Lock으로 **물리적으로 역행·스킵이 불가능**한 구조를 만들어야 한다.

### 원칙 4: API와 Worker는 책임이 완전히 분리된다 (Layer Separation)
API 서버가 DB에 쓰는 순간, API 서버의 응답 속도가 DB 성능에 종속된다. API 서버는 Redis(인메모리) 검증과 BullMQ 적재만으로 즉시 응답해야 하며, 무거운 처리는 모두 Worker에 위임한다.

### 원칙 5: 외부 시스템은 신뢰하지 않는다 (External System Distrust)
POS 시스템은 레거시이며, 언제든 느려지거나 다운될 수 있다. 서킷 브레이커 없이 POS에 직접 연결하면 단일 매장의 POS 장애가 전체 Worker 스레드를 고갈시킨다. 모든 외부 연동은 ACL + Circuit Breaker를 통해서만 허용한다.
