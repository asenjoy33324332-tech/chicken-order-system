# 부하 테스트 실행 스크립트
# 사용법: .\tests\load\run-load-test.ps1 [-Scenario all|load|idempotency|spike] [-BaseUrl http://localhost:3000]

param(
    [ValidateSet('all', 'load', 'idempotency', 'spike')]
    [string]$Scenario = 'all',
    [string]$BaseUrl = 'http://localhost:3000',
    [string]$OutputDir = 'tests\load\results'
)

$Timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$ResultDir = "$OutputDir\$Timestamp"
New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null

Write-Host "=== 치킨 프랜차이즈 주문 시스템 부하 테스트 ===" -ForegroundColor Cyan
Write-Host "시나리오: $Scenario | 대상: $BaseUrl" -ForegroundColor Cyan
Write-Host ""

# 1. 서비스 헬스 체크
Write-Host "[1/4] 서비스 헬스 체크..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod "$BaseUrl/health" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "  OK: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "  경고: 헬스 체크 실패. 서비스가 실행 중인지 확인하세요." -ForegroundColor Red
    Write-Host "  docker-compose up -d 후 재시도하세요."
    exit 1
}

# 2. k6 설치 확인
Write-Host "[2/4] k6 설치 확인..." -ForegroundColor Yellow
$k6Path = (Get-Command k6 -ErrorAction SilentlyContinue).Source
if (-not $k6Path) {
    Write-Host "  k6를 찾을 수 없습니다. 새 터미널을 열거나 PATH를 확인하세요." -ForegroundColor Red
    exit 1
}
Write-Host "  OK: $k6Path" -ForegroundColor Green

# 3. 부하 테스트 실행
Write-Host "[3/4] 부하 테스트 실행 중..." -ForegroundColor Yellow
$SummaryJson = "$ResultDir\summary.json"
$HtmlReport  = "$ResultDir\report.html"

$k6Args = @(
    'run',
    '--env', "BASE_URL=$BaseUrl",
    '--out', "json=$SummaryJson",
    'tests\load\order-load-test.js'
)

# 특정 시나리오만 실행하려면 --include-scenario 옵션 사용
if ($Scenario -ne 'all') {
    # 시나리오 이름 매핑
    $scenarioMap = @{
        'load'         = 'load_ramp'
        'idempotency'  = 'idempotency_burst'
        'spike'        = 'spike'
    }
    $k6Args += '--include-scenario', $scenarioMap[$Scenario]
}

$exitCode = 0
& k6 @k6Args
$exitCode = $LASTEXITCODE

# 4. 결과 분석
Write-Host ""
Write-Host "[4/4] 결과 분석..." -ForegroundColor Yellow

if ($exitCode -eq 0) {
    Write-Host "  모든 임계값 통과!" -ForegroundColor Green
} else {
    Write-Host "  임계값 위반 항목이 있습니다. 결과 확인: $SummaryJson" -ForegroundColor Red
}

# 주요 메트릭 출력 (summary.json 파싱)
if (Test-Path $SummaryJson) {
    Write-Host ""
    Write-Host "=== 주요 메트릭 요약 ===" -ForegroundColor Cyan

    # 마지막 summary 라인 찾기
    $summaryLines = Get-Content $SummaryJson | Where-Object { $_ -match '"type":"Point"' } | Select-Object -Last 100

    $metrics = @('http_req_duration', 'http_req_failed', 'order_created', 'duplicate_blocked')
    foreach ($metric in $metrics) {
        $line = $summaryLines | Where-Object { $_ -match "`"$metric`"" } | Select-Object -Last 1
        if ($line) {
            $data = $line | ConvertFrom-Json
            Write-Host "  $metric`: $($data.data.value)" -ForegroundColor White
        }
    }
}

Write-Host ""
Write-Host "결과 저장 위치: $ResultDir" -ForegroundColor Cyan
exit $exitCode
