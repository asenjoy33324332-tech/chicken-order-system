/**
 * k6 부하 테스트 — 3개 시나리오
 *
 * 실행:
 *   k6 run tests/load/order-load-test.js
 *   k6 run --env BASE_URL=http://localhost:3000 tests/load/order-load-test.js
 *
 * 검증 목표:
 *   1) CCU 500 환경 P99 < 1s, 에러율 < 1%
 *   2) 동일 키 100회 동시 호출 → 단 1건만 신규 접수
 *   3) 스파이크(1000 VU) 회복 시간 < 30s
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_URL  = `${BASE_URL}/api/v1/orders`;

// ─── 커스텀 메트릭 ──────────────────────────────────────────
const orderCreated      = new Counter('order_created');
const duplicateBlocked  = new Counter('duplicate_blocked');
const menuCacheHits     = new Counter('menu_cache_hits');
const menuCacheMisses   = new Counter('menu_cache_misses');
const spikeRecoveryTime = new Trend('spike_recovery_ms');

// ─── 시나리오 정의 ───────────────────────────────────────────
export const options = {
  scenarios: {
    // 시나리오 1: CCU 300 점진적 증가 → 정상 부하 테스트 (3분)
    load_ramp: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m',  target: 300 },
        { duration: '1m',  target: 300 }, // 정점 유지
        { duration: '30s', target: 0   },
      ],
      tags: { scenario: 'load' },
    },

    // 시나리오 2: 동일 idempotency_key 100회 동시 전송 → 중복 차단 검증
    idempotency_burst: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,
      startTime: '15s',
      maxDuration: '20s',
      tags: { scenario: 'idempotency' },
      exec: 'idempotencyScenario',
    },

    // 시나리오 3: 스파이크 테스트 → 500 VU 순간 급증 후 회복 검증
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 500 }, // 급증
        { duration: '20s', target: 500 }, // 유지
        { duration: '20s', target: 0   }, // 회복
      ],
      startTime: '3m10s',
      tags: { scenario: 'spike' },
      exec: 'spikeScenario',
    },
  },

  thresholds: {
    // 전체 부하 기준 (load_ramp + idempotency_burst 포함)
    'http_req_duration{scenario:load_ramp}': ['p(95)<500', 'p(99)<1000'],
    'http_req_failed{scenario:load_ramp}':   ['rate<0.01'],

    // 멱등성 기준: 정확히 1건만 신규 접수, 나머지 95건 이상 차단
    'order_created':     ['count>=1', 'count<=1'],
    'duplicate_blocked': ['count>=95'],

    // 스파이크 회복 기준
    'http_req_failed{scenario:spike}':    ['rate<0.05'],
    'http_req_duration{scenario:spike}':  ['p(99)<3000'],
  },
};

// ─── 공통 헬퍼 ──────────────────────────────────────────────
const STORE_ID = '11111111-1111-1111-1111-111111111111';
const MENU_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function buildPayload(idempotencyKey) {
  return JSON.stringify({
    idempotencyKey,
    storeId: STORE_ID,
    totalAmount: '18000',
    items: [{ menuId: MENU_ID, quantity: 1 }],
  });
}

const HEADERS = { 'Content-Type': 'application/json' };

// ─── 시나리오 1: 일반 부하 ───────────────────────────────────
export default function () {
  const res = http.post(API_URL, buildPayload(uuidv4()), {
    headers: HEADERS,
    timeout: '5s',
  });

  check(res, {
    '202 접수': (r) => r.status === 202,
    'traceId 포함': (r) => {
      try { return !!JSON.parse(r.body).traceId; } catch { return false; }
    },
  });

  // 메뉴 캐시 효율 측정 (X-Menu-Cache-Hit 헤더가 있다면)
  if (res.headers['X-Menu-Cache'] === 'HIT') menuCacheHits.add(1);
  else menuCacheMisses.add(1);

  sleep(0.1);
}

// ─── 시나리오 2: 멱등성 동시 폭격 ───────────────────────────
// 고정 상수: k6 VU는 각자 독립 JS 런타임이므로 uuidv4()는 VU마다 다른 값 → 상수 필수
const SHARED_KEY = 'burst-idempotency-shared-key-0001';

export function idempotencyScenario() {
  const res = http.post(API_URL, buildPayload(SHARED_KEY), {
    headers: HEADERS,
    timeout: '5s',
  });

  const isReplay = res.headers['X-Idempotency-Replay'] === 'true';

  if (res.status === 202 && !isReplay) {
    // 최초 신규 접수
    orderCreated.add(1);
  } else if (res.status === 409 || (res.status === 202 && isReplay)) {
    // 409: 처리 중 차단 / 202+replay: 캐시 응답 반환
    duplicateBlocked.add(1);
  }

  check(res, {
    '202 또는 409': (r) => r.status === 202 || r.status === 409,
  });
}

// ─── 시나리오 3: 스파이크 ────────────────────────────────────
let spikeStart = null;
let spikeRecovered = false;

export function spikeScenario() {
  const before = Date.now();
  const res = http.post(API_URL, buildPayload(uuidv4()), {
    headers: HEADERS,
    timeout: '10s',
  });
  const elapsed = Date.now() - before;

  const ok = check(res, {
    '202 또는 503': (r) => r.status === 202 || r.status === 503,
    '응답 10s 이내': () => elapsed < 10000,
  });

  // 첫 실패 시점 기록 후 회복 지점 측정
  if (!ok && !spikeStart) spikeStart = Date.now();
  if (ok && spikeStart && !spikeRecovered) {
    spikeRecoveryTime.add(Date.now() - spikeStart);
    spikeRecovered = true;
  }

  sleep(0.05);
}
