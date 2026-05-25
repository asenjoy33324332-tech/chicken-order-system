# 차세대 프랜차이즈 통합 주문 시스템

## 프로젝트 목표

주문 유실 0건 / 데이터 무결성 100% — CCU 500명 환경에서도 깨지지 않는 주문 처리 인프라

## 기술 스택

- **API / Worker**: TypeScript + NestJS
- **메시지 큐**: BullMQ (Redis 기반)
- **캐시 / 분산 락**: Redis (ElastiCache)
- **데이터베이스**: PostgreSQL 15 (RDS)
- **인프라**: AWS ECS Fargate + CDK (IaC)

## 설계 문서 (1차 산출물)

개발 착수 전 제출 문서. [`docs/`](./docs/) 디렉터리 참조.

| 문서 | 핵심 내용 |
|------|---------|
| [00 인덱스](./docs/00-index.md) | 설계 원칙 5가지 |
| [01 아키텍처](./docs/01-architecture-overview.md) | API/Worker 분리, 데이터 흐름 다이어그램 |
| [02 데이터 모델](./docs/02-data-model.md) | PostgreSQL 스키마, 인덱스, Deadlock 방지 |
| [03 상태 머신](./docs/03-state-machine.md) | QUEUED→SAVED→SENT_TO_POS→COMPLETED 강제 |
| [04 동시성 제어](./docs/04-concurrency-control.md) | 3중 방어 (Redis SETNX / 분산 락 / DB Unique) |
| [05 장애 대응](./docs/05-fault-tolerance.md) | 서킷 브레이커, DLQ, ACL, Graceful Shutdown |
| [06 옵저버빌리티](./docs/06-observability.md) | traceId E2E 추적, 구조화 로그, 운영 대시보드 |
| [07 인프라](./docs/07-infra-proposal.md) | AWS 아키텍처, TCO 산출, Auto-scaling 정책 |

## 6단계 실행 로드맵

```
[1단계: 설계 완료] ──▶ [2단계: DB + 인프라] ──▶ [3단계: API 서버]
                                                        │
[6단계: 부하 테스트] ◀── [5단계: 장애 파이프라인] ◀── [4단계: Worker]
```

## 검증 기준

- [ ] CCU 500 환경 주문 유실 0건
- [ ] 동일 요청 100회 동시 호출 시 단 1건만 생성
- [ ] 배포 중 큐 처리 중단 없음
- [ ] POS 장애 시 전체 시스템 영향 없음
