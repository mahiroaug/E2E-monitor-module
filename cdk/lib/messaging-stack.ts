/**
 * MessagingStack
 *
 * 本スタックで参照される設定:
 * - context 'stage'（dev|stg|prod）: SQS/Lambda 名称サフィックス
 * - env SSM_PREFIX: Lambda 環境変数で参照（既定 /E2E-module/）
 */
import { Stack, StackProps, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Queue, DeadLetterQueue } from 'aws-cdk-lib/aws-sqs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { join } from 'path';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';

export interface MessagingStackProps extends StackProps {
  notificationTopic?: Topic;
}

export class MessagingStack extends Stack {
  public readonly queue: Queue;
  public readonly dlq: Queue;
  public readonly txSenderFn: NodejsFunction;

  constructor(scope: Construct, id: string, props?: MessagingStackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    this.dlq = new Queue(this, 'Dlq', {
      queueName: `e2emm-main-dlq-${stage}`,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.queue = new Queue(this, 'MainQueue', {
      queueName: `e2emm-main-queue-${stage}`,
      visibilityTimeout: Duration.seconds(210),
      deadLetterQueue: { maxReceiveCount: 1, queue: this.dlq } as DeadLetterQueue,
    });

    // Lambda: tx-sender（既存 JS を参照）
    this.txSenderFn = new NodejsFunction(this, 'TxSenderFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/tx-sender/index.js'),
      handler: 'handler',
      functionName: `e2emm-tx-sender-${stage}`,
      memorySize: 512,
      timeout: Duration.seconds(180),
      logRetention: RetentionDays.ONE_YEAR,
      bundling: { minify: true, externalModules: ['aws-sdk'] },
      environment: {
        SSM_PREFIX: '/E2E-module/',
        RPC_URL: process.env.RPC_URL || '',
        CHAIN_ID: process.env.CHAIN_ID || '',
      },
    });

    this.txSenderFn.addEventSource(new SqsEventSource(this.queue, {
      batchSize: 1,
      // SQS Partial Batch Response を使用（成功時は削除・再試行対象のみを返す）
      reportBatchItemFailures: true,
    }));

    // 最小権限: SSM 参照
    this.txSenderFn.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: ['*'],
    }));

    // --- Alarms for rapid triage ---
    if (props?.notificationTopic) {
      // Lambda Errors
      const errorsMetric = new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: { FunctionName: this.txSenderFn.functionName },
        period: Duration.minutes(5),
        statistic: 'sum',
      });
      const errorsAlarm = new Alarm(this, 'TxSenderErrorsAlarm', {
        metric: errorsMetric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmName: `${this.txSenderFn.functionName}--WARN--failed`,
        alarmDescription: 'severity=WARN: Lambda Errors >= 1 (5m sum).',
      });
      errorsAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
      Tags.of(errorsAlarm).add('severity', 'WARN');

      // Lambda Throttles（任意。スパイク検知）
      const throttlesMetric = new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Throttles',
        dimensionsMap: { FunctionName: this.txSenderFn.functionName },
        period: Duration.minutes(5),
        statistic: 'sum',
      });
      const throttlesAlarm = new Alarm(this, 'TxSenderThrottlesAlarm', {
        metric: throttlesMetric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmName: `${this.txSenderFn.functionName}--WARN--throttled`,
        alarmDescription: 'severity=WARN: Lambda Throttles >= 1 (5m sum).',
      });
      throttlesAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
      Tags.of(throttlesAlarm).add('severity', 'WARN');

      // DLQ visible messages >= 1
      const dlqVisibleMetric = new Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: { QueueName: this.dlq.queueName },
        period: Duration.minutes(5),
        statistic: 'max',
      });
      const dlqAlarm = new Alarm(this, 'MainDlqMessagesVisibleAlarm', {
        metric: dlqVisibleMetric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmName: `${this.dlq.queueName}--WARN--dlq-messages-visible`,
        alarmDescription: 'severity=WARN: SQS DLQ ApproximateNumberOfMessagesVisible >= 1 (5m max).',
      });
      dlqAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
      Tags.of(dlqAlarm).add('severity', 'WARN');
    }
  }
}


