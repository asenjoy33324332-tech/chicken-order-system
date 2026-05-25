# 05. 장애 대응 설계 (Fault-Tolerance)

## 설계 전제: 모든 외부 의존성은 언젠가 실패한다

POS 시스템, 네트워크, DB 커넥션 — 이들이 정상 작동하는 것을 가정하고 설계하면 안 된다. 이들이 실패할 때 **시스템 전체가 멈추지 않고 영향을 격리**해야 한다.

---

## 1. 서킷 브레이커 (Circuit Breaker)

### 왜 필요한가

서킷 브레이커 없이 POS가 다운되면:
```
Worker → POS (timeout 10초) → 실패
Worker → POS (timeout 10초) → 실패
Worker → POS (timeout 10초) → 실패
...
```
모든 Worker 스레드가 POS 응답을 기다리며 대기 → Worker 스레드 풀 고갈 → 다른 매장 주문도 처리 불가 → **단일 매장 POS 장애가 전체 시스템 마비로 확산**.

서킷 브레이커는 이 확산을 막기 위해 **장애가 감지된 즉시 해당 POS 연결을 차단**한다.

### 상태 전이 (매장별 독립 인스턴스)

```
CLOSED ──────────────────────────────▶ OPEN
(정상)  실패율 > 50% (최근 10회 기준)  (차단)
  ▲     또는 연속 5회 실패               │
  │                                     │ 30초 후
  │                                     ▼
  └─────────────── 성공 ────── HALF-OPEN
                                (1회 프로브)
                                       │
                                       └─ 실패 → OPEN (리셋)
```

### 구현

```typescript
// src/order/infrastructure/circuit-breaker/pos-circuit-breaker.ts

import { Policy, ConsecutiveBreaker, ExponentialBackoff } from 'cockatiel';

export class PosCircuitBreaker {
  private readonly policy: ReturnType<typeof Policy.wrap>;
  private readonly storeId: string;

  constructor(storeId: string, private readonly redis: Redis) {
    this.storeId = storeId;

    // 서킷 브레이커 + 재시도 정책 조합
    const circuitBreaker = Policy.handleAll().circuitBreaker(
      30_000,          // OPEN 유지 시간: 30초
      new ConsecutiveBreaker(5),  // 연속 5회 실패 시 OPEN
    );

    const retry = Policy.handleAll().retry().attempts(3).backoff(
      new ExponentialBackoff({ maxDelay: 4000, initialDelay: 1000 }),
    );

    // 재시도 → 서킷 브레이커 순서로 wrapping
    // (서킷 브레이커 → 재시도 순서면 CB가 열릴 때 재시도가 CB를 계속 두드림)
    this.policy = Policy.wrap(retry, circuitBreaker);
  }

  async sendToPOS<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await this.policy.execute(fn);
      await this.recordResult('success');
      return result;
    } catch (error) {
      await this.recordResult('failure', error.message);
      throw error;
    }
  }

  private async recordResult(result: 'success' | 'failure', reason?: string): Promise<void> {
    // Redis에 서킷 브레이커 상태 기록 (모니터링 및 대시보드용)
    const key = `cb:store:${this.storeId}`;
    await this.redis.hset(key, {
      lastResult: result,
      lastReason: reason ?? '',
      updatedAt: new Date().toISOString(),
    });
    await this.redis.expire(key, 3600);
  }
}

// 서킷 브레이커 인스턴스는 매장별로 싱글턴 관리
// (매장 A의 서킷이 열려도 매장 B는 독립적으로 정상 처리)
export class PosCircuitBreakerRegistry {
  private readonly registry = new Map<string, PosCircuitBreaker>();

  get(storeId: string): PosCircuitBreaker {
    if (!this.registry.has(storeId)) {
      this.registry.set(storeId, new PosCircuitBreaker(storeId, this.redis));
    }
    return this.registry.get(storeId)!;
  }
}
```

---

## 2. 지수 백오프 재시도 (Exponential Backoff)

### BullMQ 재시도 정책

```typescript
// src/order/worker/queue.config.ts

export const ORDERS_QUEUE_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,   // 1차: 1초, 2차: 2초, 3차: 4초
  },
  removeOnComplete: { count: 1000 },  // 완료 job 1000개까지 보관
  removeOnFail: false,                // 실패 job은 DLQ로 이동 전까지 보관
};
```

### 재시도 시나리오별 분류

| 오류 유형 | 재시도 여부 | 이유 |
|---------|-----------|------|
| POS 타임아웃 | O | 일시적 오류, 재시도 유효 |
| POS HTTP 5xx | O | POS 서버 일시 장애 |
| POS HTTP 4xx | X | 잘못된 요청, 재시도해도 동일 결과 |
| DB 연결 오류 | O | 일시적 오류 |
| 금액 불일치 | X | 비즈니스 오류, 재시도 무의미 |
| 메뉴 없음 | X | 비즈니스 오류, 재시도 무의미 |

```typescript
// src/order/worker/order.processor.ts

@OnQueueFailed()
async onJobFailed(job: Job, error: Error): Promise<void> {
  const isRetryable = !(error instanceof BusinessLogicError);

  if (!isRetryable || job.attemptsMade >= 3) {
    // DLQ로 이관
    await this.moveToDLQ(job, error);
    return;
  }

  // BullMQ가 자동으로 backoff 재시도 처리
  this.logger.warn({
    traceId: job.data.traceId,
    orderId: job.data.orderId,
    attempt: job.attemptsMade,
    error: error.message,
    event: 'ORDER_RETRY_SCHEDULED',
  });
}
```

---

## 3. Dead Letter Queue (DLQ)

### 왜 DLQ인가

재시도가 모두 실패한 job을 그냥 버리면 주문이 유실된다. 메인 큐에 남겨두면 계속 재시도하면서 다른 정상 주문 처리를 방해한다. DLQ에 격리하면:
- 메인 큐에는 처리 가능한 job만 남아 처리 속도 유지
- 실패한 job은 DLQ에 안전하게 보관
- 운영자가 원인 분석 후 선택적 재처리 가능

### DLQ 이관 구현

```typescript
// src/order/worker/dlq.service.ts

export class DlqService {
  async moveToDLQ(job: Job<OrderJobPayload>, error: Error): Promise<void> {
    const { orderId, traceId, storeId } = job.data;

    // 1) DLQ 큐에 job 이동
    await this.dlqQueue.add('failed-order', {
      ...job.data,
      failedAt: new Date().toISOString(),
      failureReason: error.message,
      originalJobId: job.id,
      attempts: job.attemptsMade,
    });

    // 2) DB 상태 FAILED로 업데이트
    await this.orderRepository.transitionStatus(
      orderId, 'SAVED', 'FAILED', job.data.version, this.workerId,
    );
    await this.orderRepository.setDlqInfo(orderId, error.message);

    // 3) 알림 트리거
    await this.notificationService.sendAlert({
      channel: '#order-failures',
      message: `주문 처리 실패: ${orderId}`,
      details: {
        traceId,
        storeId,
        reason: error.message,
        attempts: job.attemptsMade,
        dashboardUrl: `https://admin.example.com/orders/${orderId}`,
      },
    });

    this.logger.error({
      traceId,
      orderId,
      storeId,
      error: error.message,
      attempts: job.attemptsMade,
      event: 'ORDER_MOVED_TO_DLQ',
    });
  }
}
```

### 수동 재처리 (Re-drive) API

```typescript
// src/admin/order-recovery.controller.ts

// 단일 주문 재처리
@Post('/admin/orders/:orderId/redrive')
async redriveOrder(@Param('orderId') orderId: string): Promise<void> {
  const order = await this.orderRepository.findById(orderId);

  if (order.status !== 'FAILED') {
    throw new BadRequestException('FAILED 상태인 주문만 재처리 가능합니다.');
  }

  // FAILED → QUEUED 전이 (상태 머신에서 관리자 전용으로 허용)
  await this.orderRepository.transitionStatus(
    orderId, 'FAILED', 'QUEUED', order.version, 'admin-redrive',
  );

  // DLQ에서 원본 job 데이터 조회 후 메인 큐에 재적재
  await this.ordersQueue.add('process-order', {
    ...order.jobPayload,
    isRedrive: true,
    redriveAt: new Date().toISOString(),
  });
}

// DLQ 목록 조회 (대시보드용)
@Get('/admin/orders/dlq')
async getDlqOrders(@Query() query: DlqQueryDto): Promise<DlqOrderListDto> {
  return this.orderRepository.findFailedOrders({
    storeId: query.storeId,
    from: query.from,
    to: query.to,
    page: query.page,
  });
}
```

---

## 4. Anti-Corruption Layer (ACL)

### 왜 ACL인가

각 매장의 POS는 서로 다른 API 스펙을 가진다. ACL 없이 직접 연동하면:
- 도메인 모델이 POS 스펙에 오염됨 (Legacy POS 필드명, 날짜 형식 등)
- POS 스펙 변경 시 핵심 비즈니스 로직 전체를 수정해야 함

ACL은 내부 도메인 모델 ↔ 외부 POS 스펙 변환을 전담한다.

```typescript
// src/order/infrastructure/pos/pos-adapter.interface.ts

export interface PosAdapter {
  sendOrder(order: DomainOrder): Promise<PosOrderResult>;
  cancelOrder(orderId: string, reason: string): Promise<void>;
}

// src/order/infrastructure/pos/adapters/legacy-v1.adapter.ts
// LEGACY_V1 POS: XML 기반, 날짜 YYYYMMDD 형식

export class LegacyV1PosAdapter implements PosAdapter {
  async sendOrder(order: DomainOrder): Promise<PosOrderResult> {
    // 내부 도메인 → Legacy POS XML 변환
    const xmlPayload = this.buildXmlPayload(order);
    const response = await this.httpClient.post(
      this.endpoint,
      xmlPayload,
      {
        headers: {
          'Content-Type': 'application/xml',
          'X-Order-Idempotency': order.idempotencyKey,  // 멱등성 키 전달
        },
        timeout: 5000,
      },
    );
    return this.parseXmlResponse(response.data);
  }

  private buildXmlPayload(order: DomainOrder): string {
    // 도메인 모델 → Legacy XML 변환 로직
    return `<ORDER>
      <STORE_ID>${order.storeId}</STORE_ID>
      <ORDER_DATE>${format(order.createdAt, 'yyyyMMdd')}</ORDER_DATE>
      <ITEMS>
        ${order.items.map(item => `
          <ITEM>
            <MENU_CODE>${item.menuId}</MENU_CODE>
            <QTY>${item.quantity}</QTY>
            <PRICE>${item.unitPrice * 100}</PRICE>  <!-- 원 → 전 변환 -->
          </ITEM>
        `).join('')}
      </ITEMS>
    </ORDER>`;
  }
}

// src/order/infrastructure/pos/adapters/modern-v2.adapter.ts
// MODERN_V2 POS: REST JSON API

export class ModernV2PosAdapter implements PosAdapter {
  async sendOrder(order: DomainOrder): Promise<PosOrderResult> {
    const response = await this.httpClient.post('/orders', {
      storeCode: order.storeId,
      orderTime: order.createdAt.toISOString(),
      menuItems: order.items.map(item => ({
        code: item.menuId,
        count: item.quantity,
        priceKrw: item.unitPrice,
      })),
      idempotencyKey: order.idempotencyKey,
    });
    return { posOrderId: response.data.id, status: 'ACCEPTED' };
  }
}

// 팩토리: pos_type 기준으로 올바른 어댑터 반환
export class PosAdapterFactory {
  create(posType: string): PosAdapter {
    switch (posType) {
      case 'LEGACY_V1': return new LegacyV1PosAdapter(this.config);
      case 'MODERN_V2': return new ModernV2PosAdapter(this.config);
      default: throw new UnknownPosTypeError(posType);
    }
  }
}
```

---

## 5. 장애 시나리오별 처리 매트릭스

| 장애 상황 | 영향 범위 | 대응 메커니즘 | 복구 방법 |
|---------|---------|------------|---------|
| POS 단일 매장 다운 | 해당 매장만 | 서킷 브레이커 OPEN | POS 복구 시 CB HALF-OPEN → 자동 복구 |
| POS 전체 다운 | 전체 POS 연동 | 주문은 SAVED 상태로 유지, DLQ 이관 | 수동 Re-drive |
| Redis 다운 | 멱등성 검증 불가 | API 503 반환 | Redis 클러스터 자동 복구 |
| BullMQ Queue 지연 | 주문 처리 지연 | 큐 깊이 알림 트리거 | Worker 인스턴스 수 증가 |
| Worker 크래시 | 처리 중 job 지연 | BullMQ lockDuration 후 자동 재시도 | BullMQ 자동 재분배 |
| DB Primary 다운 | Write 불가 | Worker 재시도, DB failover | RDS Multi-AZ 자동 failover |
| DB 연결 고갈 | Write 지연 | 커넥션 풀 대기 큐 | 커넥션 풀 크기 조정 |
| 배포 중 Worker 재시작 | 처리 중 job 지연 | Graceful shutdown: 현재 job 완료 후 종료 | 무중단 롤링 배포 |

---

## 6. Graceful Shutdown (무중단 배포)

배포 시 Worker가 즉시 종료되면 처리 중인 job이 유실될 수 있다.

```typescript
// src/main.ts

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);

  // SIGTERM 수신 시 (k8s/ECS graceful shutdown 신호)
  process.on('SIGTERM', async () => {
    logger.info({ event: 'GRACEFUL_SHUTDOWN_START' });

    // 1) 새 job 수신 중단
    await workerService.pauseQueue();

    // 2) 현재 처리 중인 job들 완료 대기 (최대 60초)
    await workerService.waitForActiveJobs(60_000);

    // 3) DB 커넥션 정리
    await app.close();

    logger.info({ event: 'GRACEFUL_SHUTDOWN_COMPLETE' });
    process.exit(0);
  });
}
```

ECS Task Definition의 `stopTimeout`을 70초로 설정 (graceful shutdown 60초 + 여유 10초).
