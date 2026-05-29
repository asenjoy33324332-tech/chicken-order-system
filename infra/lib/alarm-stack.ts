import * as cdk          from 'aws-cdk-lib';
import * as cloudwatch   from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions   from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns          from 'aws-cdk-lib/aws-sns';
import * as sns_subs     from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda       from 'aws-cdk-lib/aws-lambda';
import * as iam          from 'aws-cdk-lib/aws-iam';
import * as ecs          from 'aws-cdk-lib/aws-ecs';
import * as elbv2        from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds          from 'aws-cdk-lib/aws-rds';
import { Construct }     from 'constructs';

interface Props extends cdk.StackProps {
  stage: 'staging' | 'production';
  alb: elbv2.ApplicationLoadBalancer;
  apiService: ecs.FargateService;
  workerService: ecs.FargateService;
  dbInstance: rds.DatabaseInstance;
  slackWebhookUrl: string;
}

export class AlarmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const { stage, alb, apiService, workerService, dbInstance, slackWebhookUrl } = props;
    const isProd = stage === 'production';

    // ── SNS Topic ─────────────────────────────────────────────────────────
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `order-system-${stage}-alarms`,
    });

    // ── Slack Lambda ──────────────────────────────────────────────────────
    if (slackWebhookUrl) {
      const slackFn = new lambda.Function(this, 'SlackAlertFn', {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(10),
        code: lambda.Code.fromInline(`
          const https = require('https');
          exports.handler = async (event) => {
            const msg = JSON.parse(event.Records[0].Sns.Message);
            const isAlarm = msg.NewStateValue === 'ALARM';
            const text = isAlarm
              ? '🚨 *[' + process.env.STAGE + '] ' + msg.AlarmName + '*\\n' + msg.NewStateReason
              : '✅ *[' + process.env.STAGE + '] ' + msg.AlarmName + '* 복구됨';
            const body = JSON.stringify({ text });
            const url = new URL(process.env.SLACK_WEBHOOK_URL);
            await new Promise((resolve, reject) => {
              const req = https.request(
                { hostname: url.hostname, path: url.pathname + url.search,
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
                (res) => { res.resume(); resolve(res); }
              );
              req.on('error', reject);
              req.write(body);
              req.end();
            });
          };
        `),
        environment: {
          SLACK_WEBHOOK_URL: slackWebhookUrl,
          STAGE: stage,
        },
      });

      slackFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }));

      alarmTopic.addSubscription(new sns_subs.LambdaSubscription(slackFn));
    }

    const action = new cw_actions.SnsAction(alarmTopic);

    // ── 알람 헬퍼 ─────────────────────────────────────────────────────────
    const addAlarm = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    };

    // ── 1. API ECS CPU > 80% ─────────────────────────────────────────────
    addAlarm(new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
      alarmName:          `order-${stage}-api-cpu-high`,
      alarmDescription:   'API 서버 CPU 80% 초과',
      metric: apiService.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold:          80,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── 2. Worker ECS CPU > 70% ──────────────────────────────────────────
    addAlarm(new cloudwatch.Alarm(this, 'WorkerCpuAlarm', {
      alarmName:          `order-${stage}-worker-cpu-high`,
      alarmDescription:   'Worker CPU 70% 초과 — 큐 처리 지연 가능성',
      metric: workerService.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold:          70,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── 3. ALB 5xx 에러율 > 1% ───────────────────────────────────────────
    const alb5xxRate = new cloudwatch.MathExpression({
      expression: '(m1 / m2) * 100',
      usingMetrics: {
        m1: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
          period: cdk.Duration.minutes(1),
          statistic: 'Sum',
        }),
        m2: alb.metrics.requestCount({
          period: cdk.Duration.minutes(1),
          statistic: 'Sum',
        }),
      },
      period: cdk.Duration.minutes(1),
      label: 'ALB 5xx Rate (%)',
    });

    addAlarm(new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName:          `order-${stage}-alb-5xx-high`,
      alarmDescription:   'ALB 5xx 에러율 1% 초과',
      metric:             alb5xxRate,
      threshold:          1,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── 4. RDS CPU > 70% ─────────────────────────────────────────────────
    addAlarm(new cloudwatch.Alarm(this, 'RdsCpuAlarm', {
      alarmName:          `order-${stage}-rds-cpu-high`,
      alarmDescription:   'RDS CPU 70% 초과',
      metric: dbInstance.metricCPUUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold:          70,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── 5. RDS 여유 스토리지 < 5GB ───────────────────────────────────────
    addAlarm(new cloudwatch.Alarm(this, 'RdsFreeStorageAlarm', {
      alarmName:          `order-${stage}-rds-storage-low`,
      alarmDescription:   'RDS 여유 스토리지 5GB 미만',
      metric: dbInstance.metricFreeStorageSpace({
        period: cdk.Duration.minutes(10),
        statistic: 'Minimum',
      }),
      threshold:          5 * 1024 * 1024 * 1024, // 5GB (bytes)
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
