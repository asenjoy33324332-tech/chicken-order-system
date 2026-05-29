import * as cdk          from 'aws-cdk-lib';
import * as ec2           from 'aws-cdk-lib/aws-ec2';
import * as ecs           from 'aws-cdk-lib/aws-ecs';
import * as ecr           from 'aws-cdk-lib/aws-ecr';
import * as elbv2         from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam           from 'aws-cdk-lib/aws-iam';
import * as logs          from 'aws-cdk-lib/aws-logs';
import * as cloudwatch    from 'aws-cdk-lib/aws-cloudwatch';
import * as autoscaling   from 'aws-cdk-lib/aws-autoscaling';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  stage: 'staging' | 'production';
  vpc: ec2.Vpc;
  repository: ecr.Repository;
  dbSecret: secretsmanager.Secret;
  redisEndpoint: string;
  redisPort: number;
  apiTaskCount: number;
  workerTaskCount: number;
}

export class EcsStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly apiService: ecs.FargateService;
  public readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const { stage, vpc, repository, dbSecret, redisEndpoint, redisPort,
            apiTaskCount, workerTaskCount } = props;
    const isProd = stage === 'production';
    const imageTag = isProd ? 'latest' : 'staging';

    // ── ECS Cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `order-system-${stage}`,
      vpc,
      containerInsights: true,
    });

    // ── IAM: Task Execution Role ──────────────────────────────────────────
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    dbSecret.grantRead(executionRole);

    // ── IAM: Task Role ────────────────────────────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // CloudWatch 메트릭 발행 (BullMQ 큐 깊이)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // ── Log Groups ────────────────────────────────────────────────────────
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/order-system/${stage}/api`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: `/order-system/${stage}/worker`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ── 공통 환경 변수 ────────────────────────────────────────────────────
    const commonEnv: Record<string, ecs.Secret | string> = {
      NODE_ENV:       'production',
      REDIS_HOST:     redisEndpoint,
      REDIS_PORT:     String(redisPort),
      // DB 시크릿은 Secrets Manager에서 주입
      DATABASE_HOST:  ecs.Secret.fromSecretsManager(dbSecret, 'host'),
      DATABASE_PORT:  ecs.Secret.fromSecretsManager(dbSecret, 'port'),
      DATABASE_USER:  ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      DATABASE_NAME:  'orderdb',
    };

    const image = ecs.ContainerImage.fromEcrRepository(repository, imageTag);

    // ─────────────────────────────────────────────────────────────────────
    // API Service
    // ─────────────────────────────────────────────────────────────────────
    const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      cpu:    512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
    });

    const apiContainer = apiTaskDef.addContainer('api', {
      image,
      environment: {
        APP_MODE:          'api',
        PORT:              '3000',
        DB_POOL_MAX:       '30',
        NODE_ENV:          'production',
        REDIS_HOST:        redisEndpoint,
        REDIS_PORT:        String(redisPort),
        DATABASE_NAME:     'orderdb',
        CB_FAILURE_THRESHOLD:  '5',
        CB_OPEN_DURATION_MS:   '30000',
        MAX_RETRY_ATTEMPTS:    '3',
        RETRY_BASE_DELAY_MS:   '1000',
        LOCK_TTL_SECONDS:      '60',
        IDEMPOTENCY_TTL_SECONDS: '86400',
      },
      secrets: {
        DATABASE_HOST:     ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        DATABASE_PORT:     ecs.Secret.fromSecretsManager(dbSecret, 'port'),
        DATABASE_USER:     ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: apiLogGroup,
        streamPrefix: 'api',
      }),
      portMappings: [{ containerPort: 3000 }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/admin/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout:  cdk.Duration.seconds(5),
        retries:  3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc, description: 'ECS API service',
    });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: apiTaskCount,
      securityGroups: [apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });

    const apiService = this.apiService;

    // API Auto-scaling
    const apiScaling = apiService.autoScaleTaskCount({
      minCapacity: apiTaskCount,
      maxCapacity: isProd ? 20 : 3,
    });
    apiScaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown:  cdk.Duration.seconds(600),
      scaleOutCooldown: cdk.Duration.seconds(120),
    });
    apiScaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
    });

    // ── ALB ───────────────────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      loadBalancerName: `order-${stage}`,
    });

    const alb = this.alb;
    const listener = alb.addListener('Http', {
      port: 80,
      // Production에서는 HTTPS 리스너 추가 필요 (ACM 인증서)
    });

    listener.addTargets('ApiTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: {
        path: '/admin/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    apiSg.addIngressRule(
      ec2.Peer.securityGroupId(alb.connections.securityGroups[0].securityGroupId),
      ec2.Port.tcp(3000),
      'ALB to API',
    );

    // ─────────────────────────────────────────────────────────────────────
    // Worker Service
    // ─────────────────────────────────────────────────────────────────────
    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu:    1024,
      memoryLimitMiB: 2048,
      executionRole,
      taskRole,
    });

    workerTaskDef.addContainer('worker', {
      image,
      environment: {
        APP_MODE:           'worker',
        DB_POOL_MAX:        '20',
        NODE_ENV:           'production',
        REDIS_HOST:         redisEndpoint,
        REDIS_PORT:         String(redisPort),
        DATABASE_NAME:      'orderdb',
        WORKER_CONCURRENCY: '20',
        WORKER_RATE_LIMIT:  '100',
        CB_FAILURE_THRESHOLD:  '5',
        CB_OPEN_DURATION_MS:   '30000',
        MAX_RETRY_ATTEMPTS:    '3',
        RETRY_BASE_DELAY_MS:   '1000',
        LOCK_TTL_SECONDS:      '60',
        IDEMPOTENCY_TTL_SECONDS: '86400',
      },
      secrets: {
        DATABASE_HOST:     ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        DATABASE_PORT:     ecs.Secret.fromSecretsManager(dbSecret, 'port'),
        DATABASE_USER:     ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: workerLogGroup,
        streamPrefix: 'worker',
      }),
    });

    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc, description: 'ECS Worker service (no inbound)',
    });

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: workerTaskDef,
      desiredCount: workerTaskCount,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });

    // Worker Auto-scaling — BullMQ 큐 깊이(WaitingJobCount) 기반
    const workerService = this.workerService;
    const workerScaling = workerService.autoScaleTaskCount({
      minCapacity: workerTaskCount,
      maxCapacity: isProd ? 30 : 3,
    });

    const queueDepthMetric = new cloudwatch.Metric({
      namespace:     'OrderSystem/Queue',
      metricName:    'WaitingJobCount',
      dimensionsMap: { Stage: stage, QueueName: 'orders-main' },
      statistic:     'Maximum',
      period:        cdk.Duration.minutes(1),
    });

    workerScaling.scaleOnMetric('QueueDepthScaling', {
      metric: queueDepthMetric,
      scalingSteps: [
        { upper: 10,  change: -1 },  // 대기 10 미만 → 1대 축소
        { lower: 100, change: +2 },  // 대기 100 이상 → 2대 증설
        { lower: 500, change: +5 },  // 대기 500 이상 → 5대 증설
      ],
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(isProd ? 300 : 60),
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ApiServiceName', { value: apiService.serviceName });
    new cdk.CfnOutput(this, 'WorkerServiceName', { value: workerService.serviceName });
  }
}
