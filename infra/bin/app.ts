#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack }    from '../lib/data-stack';
import { EcrStack }     from '../lib/ecr-stack';
import { EcsStack }     from '../lib/ecs-stack';
import { IamStack }     from '../lib/iam-stack';

const app = new cdk.App();

const stage = app.node.tryGetContext('stage') as 'staging' | 'production' ?? 'staging';
const env   = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2',
};

// ?Ä?Ä ECR (Í≥µÏú†: staging/production ?ôÏùº ?àÌè¨) ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
const ecr = new EcrStack(app, 'OrderSystem-ECR', { env });

// ?Ä?Ä IAM (GitHub OIDC Î°? ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
const iam = new IamStack(app, 'OrderSystem-IAM', {
  env,
  ecrArn: ecr.repository.repositoryArn,
  githubOrg: 'asenjoy33324332-tech',
  githubRepo: 'chicken-order-system', // ???§Ï†ú ?àÌè¨ ?¥Î¶Ñ?ºÎ°ú Î≥ÄÍ≤?});

// ?Ä?Ä Staging ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
const stagingNetwork = new NetworkStack(app, 'OrderSystem-Staging-Network', { env, stage: 'staging' });
const stagingData    = new DataStack(app, 'OrderSystem-Staging-Data', {
  env, stage: 'staging', vpc: stagingNetwork.vpc,
});
new EcsStack(app, 'OrderSystem-Staging-ECS', {
  env, stage: 'staging',
  vpc:           stagingNetwork.vpc,
  repository:    ecr.repository,
  dbSecret:      stagingData.dbSecret,
  redisEndpoint: stagingData.redisEndpoint,
  redisPort:     stagingData.redisPort,
  apiTaskCount:  1,
  workerTaskCount: 1,
});

// ?Ä?Ä Production ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
const prodNetwork = new NetworkStack(app, 'OrderSystem-Prod-Network', { env, stage: 'production' });
const prodData    = new DataStack(app, 'OrderSystem-Prod-Data', {
  env, stage: 'production', vpc: prodNetwork.vpc,
});
new EcsStack(app, 'OrderSystem-Prod-ECS', {
  env, stage: 'production',
  vpc:           prodNetwork.vpc,
  repository:    ecr.repository,
  dbSecret:      prodData.dbSecret,
  redisEndpoint: prodData.redisEndpoint,
  redisPort:     prodData.redisPort,
  apiTaskCount:  2,
  workerTaskCount: 2,
});

app.synth();
