import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export class EcrStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'chicken-order-system',
      // staging/production 이미지를 tag로 구분, 레포는 공유
      lifecycleRules: [
        {
          // staging 이미지: 최근 10개만 유지
          rulePriority: 1,
          tagPrefixList: ['staging-'],
          maxImageCount: 10,
          description: 'Keep last 10 staging images',
        },
        {
          // production 이미지: 최근 30개 유지 (롤백 대비)
          rulePriority: 2,
          tagPrefixList: ['v-'],
          maxImageCount: 30,
          description: 'Keep last 30 production images',
        },
      ],
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'RepositoryUri', { value: this.repository.repositoryUri });
  }
}
