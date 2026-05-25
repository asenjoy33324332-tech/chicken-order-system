import * as cdk  from 'aws-cdk-lib';
import * as iam  from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  ecrArn: string;
  githubOrg: string;
  githubRepo: string;
}

/**
 * GitHub Actions OIDC 롤 — AWS 액세스 키 없이 GitHub Actions에서 ECR/ECS 접근
 *
 * 설정 방법:
 *   1. cdk deploy OrderSystem-IAM
 *   2. 출력된 GitHubActionsRoleArn을 GitHub Secrets > AWS_ROLE_ARN에 등록
 */
export class IamStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const { ecrArn, githubOrg, githubRepo } = props;

    // GitHub OIDC Provider (계정당 1개)
    const oidcProvider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    // GitHub Actions가 Assume할 롤
    const githubRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: 'order-system-github-actions',
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${githubOrg}/${githubRepo}:*`,
        },
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
      }),
    });

    // ECR 권한
    githubRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
        'ecr:PutImage',
      ],
      resources: [ecrArn, `${ecrArn}:*`],
    }));

    githubRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // ECS 배포 권한
    githubRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:DescribeServices',
        'ecs:DescribeTaskDefinition',
        'ecs:DescribeTasks',
        'ecs:ListTasks',
        'ecs:RegisterTaskDefinition',
        'ecs:UpdateService',
      ],
      resources: ['*'],
    }));

    // ECS 태스크 실행 역할 PassRole
    githubRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: ['*'],
      conditions: {
        StringLike: {
          'iam:PassedToService': 'ecs-tasks.amazonaws.com',
        },
      },
    }));

    // CodeDeploy (Blue/Green, production)
    githubRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'codedeploy:CreateDeployment',
        'codedeploy:GetDeployment',
        'codedeploy:GetDeploymentConfig',
        'codedeploy:RegisterApplicationRevision',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      value: githubRole.roleArn,
      description: 'GitHub Secrets > AWS_ROLE_ARN에 등록',
    });
  }
}
