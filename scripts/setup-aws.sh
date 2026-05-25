#!/usr/bin/env bash
# AWS 최초 배포 셋업 스크립트
# 실행: bash scripts/setup-aws.sh
#
# 사전 조건:
#   - AWS CLI 설치 및 인증 완료 (aws configure)
#   - Node.js 20+ 설치
#   - infra/bin/app.ts의 githubOrg, githubRepo 수정 완료

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
echo "▶ AWS Region: $REGION"

# ── 1. CDK 부트스트랩 ─────────────────────────────────────────────────────
echo ""
echo "1️⃣  CDK Bootstrap..."
cd infra
npm install
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$REGION
cd ..

# ── 2. ECR + IAM 스택 배포 (공유 리소스, 1회만) ────────────────────────────
echo ""
echo "2️⃣  ECR + IAM 스택 배포..."
cd infra
npx cdk deploy OrderSystem-ECR OrderSystem-IAM --require-approval never
cd ..

# ── 3. GitHub Secrets 안내 ───────────────────────────────────────────────
echo ""
echo "3️⃣  아래 값들을 GitHub Secrets에 등록하세요:"
echo "   (Settings → Secrets and variables → Actions → New repository secret)"
echo ""

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI=$(aws ecr describe-repositories --repository-names chicken-order-system \
  --query 'repositories[0].repositoryUri' --output text 2>/dev/null || echo "ECR 레포 조회 실패")
GITHUB_ROLE_ARN=$(aws iam get-role --role-name order-system-github-actions \
  --query 'Role.Arn' --output text 2>/dev/null || echo "IAM 롤 조회 실패")

cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GitHub Secrets 등록 목록:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AWS_ROLE_ARN          = $GITHUB_ROLE_ARN
AWS_REGION            = $REGION
ECR_REPOSITORY        = chicken-order-system

# Staging (cdk deploy 후 출력값 복사)
ECS_CLUSTER_STAGING          = order-system-staging
ECS_SERVICE_API_STAGING      = (CDK 출력값 확인)
ECS_SERVICE_WORKER_STAGING   = (CDK 출력값 확인)

# Production
ECS_CLUSTER_PRODUCTION         = order-system-production
ECS_SERVICE_API_PRODUCTION     = (CDK 출력값 확인)
ECS_SERVICE_WORKER_PRODUCTION  = (CDK 출력값 확인)

# Optional
SLACK_WEBHOOK_URL     = https://hooks.slack.com/services/...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF

# ── 4. Staging 인프라 배포 ──────────────────────────────────────────────
echo ""
read -p "4️⃣  Staging 인프라를 지금 배포할까요? (y/N): " DEPLOY_STAGING
if [[ "$DEPLOY_STAGING" =~ ^[Yy]$ ]]; then
  cd infra
  npx cdk deploy OrderSystem-Staging-Network OrderSystem-Staging-Data OrderSystem-Staging-ECS \
    --require-approval never
  echo "✅ Staging 인프라 배포 완료"
  cd ..
fi

echo ""
echo "✅ 셋업 완료. 이제 GitHub에 push하면 CI/CD가 자동 실행됩니다."
echo "   staging 브랜치 push → Staging 자동 배포"
echo "   main 브랜치 push   → Production 자동 배포"
