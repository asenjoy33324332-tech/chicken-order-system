import * as cdk         from 'aws-cdk-lib';
import * as ec2          from 'aws-cdk-lib/aws-ec2';
import * as rds          from 'aws-cdk-lib/aws-rds';
import * as elasticache  from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  stage: 'staging' | 'production';
  vpc: ec2.Vpc;
}

export class DataStack extends cdk.Stack {
  public readonly dbSecret: secretsmanager.Secret;
  public readonly redisEndpoint: string;
  public readonly redisPort: number;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const { stage, vpc } = props;
    const isProd = stage === 'production';

    // ── Security Groups ───────────────────────────────────────────────────
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc, description: 'RDS PostgreSQL access', allowAllOutbound: false,
    });
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc, description: 'ElastiCache Redis access', allowAllOutbound: false,
    });

    // ECS 태스크에서 DB/Redis로 접근 허용 (ECS SG는 EcsStack에서 참조)
    // 여기서는 VPC CIDR 전체 허용 후 EcsStack에서 세분화
    dbSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), 'ECS → RDS');
    redisSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), 'ECS → Redis');

    // ── RDS PostgreSQL ────────────────────────────────────────────────────
    this.dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: `/order-system/${stage}/db`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'orderuser' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    const dbInstance = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: isProd
        ? ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.XLARGE)
        : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: 'orderdb',
      multiAz: isProd,
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(isProd ? 7 : 1),
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      parameterGroup: new rds.ParameterGroup(this, 'DbParamGroup', {
        engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
        parameters: {
          'statement_timeout':      '5000',   // 5초 쿼리 타임아웃
          'idle_in_transaction_session_timeout': '30000',
          'log_min_duration_statement': '1000', // 1초 이상 쿼리 로그
        },
      }),
    });

    // Production: Read Replica
    if (isProd) {
      new rds.DatabaseInstanceReadReplica(this, 'DbReadReplica', {
        sourceDatabaseInstance: dbInstance,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.LARGE),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSg],
      });
    }

    // ── ElastiCache Redis ─────────────────────────────────────────────────
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `Order system Redis subnet group (${stage})`,
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });

    const redisParamGroup = new elasticache.CfnParameterGroup(this, 'RedisParamGroup', {
      cacheParameterGroupFamily: 'redis7',
      description: `order-system-${stage} Redis parameter group (AOF enabled)`,
      properties: {
        appendonly: 'yes',
        appendfsync: 'everysec',
      },
    });

    const redisCluster = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: `order-system-${stage}`,
      numCacheClusters: isProd ? 2 : 1,   // Production: Primary + Replica
      cacheNodeType: isProd ? 'cache.r7g.large' : 'cache.t4g.small',
      engine: 'redis',
      engineVersion: '7.2',
      automaticFailoverEnabled: isProd,
      multiAzEnabled: isProd,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      cacheParameterGroupName: redisParamGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      snapshotRetentionLimit: isProd ? 5 : 0,
      snapshotWindow: '03:00-04:00',
    });
    redisCluster.addDependency(redisSubnetGroup);
    redisCluster.addDependency(redisParamGroup);

    this.redisEndpoint = redisCluster.attrPrimaryEndPointAddress;
    this.redisPort = 6379;

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DbEndpoint',    { value: dbInstance.instanceEndpoint.hostname });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisEndpoint });
    new cdk.CfnOutput(this, 'DbSecretArn',   { value: this.dbSecret.secretArn });
  }
}
