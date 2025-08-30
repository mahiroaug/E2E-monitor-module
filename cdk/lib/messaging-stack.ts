/**
 * MessagingStack
 *
 * 本スタックで参照される設定:
 * - context 'stage'（dev|stg|prod）: SQS/Lambda 名称サフィックス
 * - env SSM_PREFIX: Lambda 環境変数で参照（既定 /E2E-module/）
 */
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Queue, DeadLetterQueue } from 'aws-cdk-lib/aws-sqs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { join } from 'path';

export class MessagingStack extends Stack {
  public readonly queue: Queue;
  public readonly dlq: Queue;
  public readonly txSenderFn: NodejsFunction;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    this.dlq = new Queue(this, 'Dlq', {
      queueName: `e2emm-main-dlq-${stage}`,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.queue = new Queue(this, 'MainQueue', {
      queueName: `e2emm-main-queue-${stage}`,
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { maxReceiveCount: 5, queue: this.dlq } as DeadLetterQueue,
    });

    // Lambda: tx-sender（既存 JS を参照）
    this.txSenderFn = new NodejsFunction(this, 'TxSenderFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/recordLogHandler.js'),
      handler: 'handler',
      functionName: `e2emm-tx-sender-${stage}`,
      memorySize: 512,
      timeout: Duration.seconds(60),
      bundling: { minify: true, externalModules: ['aws-sdk'] },
      environment: {
        SSM_PREFIX: '/E2E-module/',
      },
    });

    this.txSenderFn.addEventSource(new SqsEventSource(this.queue, {
      batchSize: 1,
    }));

    // 最小権限: SSM 参照
    this.txSenderFn.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: ['*'],
    }));
  }
}


