# 치킨 프로젝트 계획서 (확정)
> 작성일: 2026-06-02

---

## 핵심 전략

- bbq 앱 껍데기 5개 → 서버 URL만 치킨 AWS ALB로 교체
- bbq 서버 기능 → 치킨 NestJS 서버에 포팅

---

## Phase 1 — 치킨 NestJS 서버에 bbq API 포팅

| 순서 | 작업 | 참고 파일 |
|------|------|-----------|
| 1 | Socket.IO 실시간 (new_order, order_updated) | socket.js |
| 2 | 주문 CRUD | routes/orders.js |
| 3 | 메뉴/카테고리/옵션 | routes/menus.js |
| 4 | KCP 결제 | routes/kcp.js + kcp-config.js |
| 5 | 설정/헬스/스플래시 | routes/misc.js |
| 6 | 매출 집계 | routes/sales.js |
| 7 | 라이더/기타 | routes/rider.js, auth.js |

> 참고 파일 위치: `C:\치킨 프로젝트\bbq_project\server\`

---

## Phase 2 — 앱 5개 서버 URL 교체 + 빌드

| 앱 | 변경 파일 | 변경 내용 |
|----|---------|---------|
| bbqpos_like | bbqpos_like/lib/core/app_config.dart | defaultServerUrl → 치킨 ALB |
| tablet_pos | tablet_pos/lib/app_constants.dart | serverBaseUrl → 치킨 ALB |
| rider_app | rider_app/lib/app_constants.dart | kServerUrl → 치킨 ALB |
| bbq_order_app | bbq_order_app/lib/app_constants.dart | serverBaseUrl → 치킨 ALB |
| table_order_app | table_order_app/lib/app_constants.dart | serverBaseUrl → 치킨 ALB |

> 치킨 AWS ALB 주소: `order-production-1043936651.ap-northeast-2.elb.amazonaws.com`

---

## Phase 3 — 테스트 및 배포

- 스테이징 ALB로 먼저 연결해서 전체 흐름 검증
- 이상 없으면 프로덕션 ALB로 전환
- 앱 스토어/기기 배포

---

## 절대 규칙

- `bbq_project/server/` 파일 수정 금지
- `asenjoy3533pos/bbq_project` 에 server/ push 금지
- bbq 서버는 Render.com에서 계속 운영 중 — 건드리면 실 매장 피해 발생
