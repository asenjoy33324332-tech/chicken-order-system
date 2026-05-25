import * as cdk from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  stage: 'staging' | 'production';
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const { stage } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `order-system-${stage}`,
      maxAzs: 2,
      natGateways: stage === 'production' ? 2 : 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // VPC Flow Logs (production만)
    if (stage === 'production') {
      new ec2.FlowLog(this, 'FlowLog', {
        resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
