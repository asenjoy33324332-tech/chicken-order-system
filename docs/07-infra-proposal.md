# 07. 클라우드 인프라 제안

## 제안 요약

**AWS를 기반으로 한 완전 관리형(Managed) 인프라**를 제안한다. 자체 관리 인프라 대비 운영 공수를 약 70% 절감하면서 99.99% 가용성을 확보할 수 있다.

---

## 1. 전체 인프라 아키텍처

```
                            인터넷
                              │
                    ┌─────────▼──────────┐
                    │   AWS CloudFront   │  DDoS 방어, SSL 종단, CDN
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │   AWS ALB          │  HTTP → HTTPS 리다이렉트
                    │   (Application     │  Target Group: ECS API 서비스
                    │    Load Balancer)  │
                    └─────────┬──────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │           VPC (10.0.0.0/16)        │
            │                 │                  │
            │   ┌─────────────▼──────────────┐   │
            │   │     Public Subnet          │   │
            │   │     (10.0.1.0/24,          │   │
            │   │      10.0.2.0/24)          │   │
            │   │   [NAT Gateway]            │   │
            │   └──────────────┬─────────────┘   │
            │                  │                  │
            │   ┌──────────────▼─────────────┐   │
            │   │     Private Subnet         │   │
            │   │     (10.0.10.0/24,         │   │
            │   │      10.0.11.0/24)         │   │
            │   │                            │   │
            │   │  [ECS Fargate: API]        │   │
            │   │  [ECS Fargate: Worker]     │   │
            │   │  [ElastiCache Redis]       │   │
            │   │  [RDS PostgreSQL]          │   │
            │   └────────────────────────────┘   │
            │                                    │
            └────────────────────────────────────┘
```

모든 애플리케이션 컴포넌트는 **Private Subnet**에 배치. 외부에서 직접 접근 불가. ALB만 Public Subnet에 위치.

---

## 2. 컴포넌트별 서비스 선택

### 2.1 API 서버 / Worker 서버: ECS Fargate

| 항목 | 선택 | 이유 |
|------|------|------|
| 런타임 | AWS ECS Fargate | EC2 관리 불필요, 컨테이너 단위 자동 스케일링 |
| Auto-scaling | ECS Service Auto Scaling | CPU/메모리 기반 + BullMQ 큐 깊이 기반 |
| 배포 방식 | Blue/Green (AWS CodeDeploy) | 트래픽 전환 전 헬스 체크, 롤백 30초 |

**API 서버 Auto-scaling 정책:**
- Scale-out: CPU > 70% (2분 연속) → +2 tasks
- Scale-in: CPU < 20% (10분 연속) → -1 task
- 최소: 2 tasks (AZ별 1개, 고가용성)
- 최대: 20 tasks

**Worker Auto-scaling 정책:**
- 큐 깊이 기반: BullMQ `waiting` 수 > 100 → +2 workers
- 큐 깊이 기반: BullMQ `waiting` 수 < 10 (10분 연속) → -1 worker
- 최소: 2 tasks
- 최대: 30 tasks

BullMQ 큐 깊이를 CloudWatch Custom Metric으로 내보내는 Lambda를 30초마다 실행:
```typescript
// 큐 깊이 메트릭 발행 Lambda
const waitingCount = await queue.getWaitingCount();
await cloudwatch.putMetricData({
  Namespace: 'OrderSystem',
  MetricData: [{ MetricName: 'BullMQWaiting', Value: waitingCount }],
}).promise();
```

### 2.2 메시지 큐: ElastiCache for Redis (BullMQ 기반)

| 항목 | 값 |
|------|-----|
| 서비스 | AWS ElastiCache for Redis |
| 모드 | Cluster Mode Enabled (샤딩 + 복제) |
| 노드 | cache.r7g.large × 3 (Primary) + 3 (Replica) |
| 다중 AZ | 활성화 |
| 장애 조치 | 자동 failover (< 60초) |
| 용도 | BullMQ Queue + 분산 락 + 멱등성 키 |

ElastiCache를 선택한 이유:
- 자동 패치, 백업, 복제 관리
- Multi-AZ 자동 failover
- BullMQ는 Redis 프로토콜을 그대로 사용하므로 호환성 문제 없음

### 2.3 데이터베이스: Amazon RDS for PostgreSQL

| 항목 | 값 |
|------|-----|
| 서비스 | AWS RDS PostgreSQL 15 |
| 인스턴스 | db.r7g.xlarge (4 vCPU, 32GB) |
| 다중 AZ | 활성화 (자동 Standby) |
| Read Replica | 1개 (API 서버 금액 검증 쿼리 분산) |
| 백업 | 자동 백업 7일 보관 |
| 장애 조치 | 자동 failover (1-2분) |

**커넥션 풀**: PgBouncer (ECS Fargate)를 API/Worker와 RDS 사이에 배치.
- 이유: ECS tasks 수가 급증할 때 PostgreSQL max_connections(최대 ~100) 한계를 초과하지 않도록.
- PgBouncer가 커넥션을 풀링하여 DB에는 항상 일정 수의 커넥션만 유지.

### 2.4 모니터링: AWS CloudWatch + Grafana

- 모든 서비스 메트릭 → CloudWatch
- 구조화 로그 → CloudWatch Logs → CloudWatch Logs Insights (traceId 검색)
- Grafana (Amazon Managed Grafana) → CloudWatch 데이터 소스로 대시보드 구성
- 알림 → CloudWatch Alarms → SNS → Slack (Lambda webhook)

---

## 3. 네트워크 격리 (보안)

```
Security Group 설계:

sg-alb:          인바운드 HTTPS(443) from 0.0.0.0/0
sg-api:          인바운드 HTTP(3000) from sg-alb only
sg-worker:       인바운드 없음 (큐 폴링은 아웃바운드)
sg-redis:        인바운드 Redis(6379) from sg-api, sg-worker only
sg-rds:          인바운드 PostgreSQL(5432) from sg-api, sg-worker only
```

Worker는 외부에서 직접 접근할 수 없고, 오직 BullMQ 큐를 통해서만 작업을 받는다.

---

## 4. TCO 산출 (월간 예상 비용)

**200개 매장, CCU 500명 피크 타임 기준**

| 서비스 | 스펙 | 월 비용 (USD) |
|--------|------|-------------|
| ECS Fargate (API) | 평균 4 tasks × 0.5 vCPU, 1GB | ~$60 |
| ECS Fargate (Worker) | 평균 6 tasks × 1 vCPU, 2GB | ~$180 |
| ElastiCache Redis | r7g.large × 6 nodes | ~$600 |
| RDS PostgreSQL | r7g.xlarge Multi-AZ + 1 Replica | ~$500 |
| ALB | 평균 처리 100GB/월 | ~$30 |
| CloudFront | CDN 1TB/월 | ~$85 |
| CloudWatch | 로그 100GB/월 | ~$50 |
| NAT Gateway | 10GB/월 | ~$35 |
| **합계** | | **~$1,540/월** |

**비용 절감 전략:**

1. **Savings Plans**: ECS Fargate에 1년 약정 적용 → 약 20% 절감
2. **피크 외 축소**: 자정~오전 6시 Worker 최소 1 task로 축소 → 약 15% 절감
3. **RDS Reserved Instance**: 1년 예약 → 약 40% 절감
4. 절감 후 예상 월 비용: **~$980/월**

---

## 5. 매장 수 증가에 따른 확장 전략

| 매장 수 | API tasks | Worker tasks | Redis | RDS | 월 비용 |
|--------|---------|------------|-------|-----|--------|
| 200 | 4 | 6 | r7g.large × 6 | r7g.xlarge | ~$980 |
| 500 | 8 | 15 | r7g.xlarge × 6 | r7g.2xlarge | ~$2,200 |
| 1,000 | 15 | 30 | r7g.2xlarge × 6 | r7g.4xlarge + 2 Replica | ~$4,500 |

확장 시 코드 변경 없이 ECS task 수, ElastiCache 노드 수, RDS 인스턴스 타입만 변경하면 된다. 이것이 Stateless API + Worker + Managed Service 조합의 핵심 이점이다.

---

## 6. IaC (Infrastructure as Code)

인프라 전체는 **AWS CDK (TypeScript)** 로 코드화한다. 이유:
- 인프라 변경 이력이 Git에 기록됨
- PR 리뷰를 통한 인프라 변경 통제
- 스테이징/프로덕션 환경을 동일 코드로 재현 가능
- TypeScript 사용으로 백엔드 개발자가 별도 언어 학습 없이 인프라 관리 가능

```typescript
// infra/lib/order-system-stack.ts (핵심 구조만 예시)

export class OrderSystemStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new Vpc(this, 'OrderVpc', { maxAzs: 2, natGateways: 1 });

    // ElastiCache Redis
    const redis = new CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: 'Order system Redis cluster',
      numCacheClusters: 2,
      cacheNodeType: 'cache.r7g.large',
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
    });

    // RDS PostgreSQL
    const db = new DatabaseInstance(this, 'OrderDb', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_15 }),
      instanceType: InstanceType.of(InstanceClass.R7G, InstanceSize.XLARGE),
      vpc, multiAz: true,
    });

    // ECS Cluster
    const cluster = new Cluster(this, 'OrderCluster', { vpc });

    // API Service
    const apiService = new FargateService(this, 'ApiService', {
      cluster, taskDefinition: apiTaskDef,
      desiredCount: 2,
    });
    apiService.autoScaleTaskCount({ maxCapacity: 20 })
      .scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70 });
  }
}
```
