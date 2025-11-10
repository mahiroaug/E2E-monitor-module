/**
 * EmailIngestStack
 *
 * 本スタックで参照される設定:
 * - context 'stage'（dev|stg|prod）: Lambda名/ロググループ名/メトリクス次元
 * - env CA_E2E_MONITOR        : 契約アドレス（任意・空可）
 * - env EXPLORER_API_URL      : エクスプローラAPI URL（既定 Polygonscan互換）
 * - env EXPLORER_API_KEY      : エクスプローラAPI Key（任意）
 */
import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { join } from 'path';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Alarm, ComparisonOperator, Metric } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';

export interface EmailIngestStackProps extends StackProps {
  bucket: Bucket;
  notificationTopic: Topic;
  table: Table;
}

export class EmailIngestStack extends Stack {
  public readonly parserFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: EmailIngestStackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    // X-Ray Tracing設定（環境変数で制御、デフォルトは有効）
    const enableXRayTracing = process.env.ENABLE_XRAY_TRACING !== 'false';
    this.parserFn = new NodejsFunction(this, 'EmailParserFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/email-ingest/index.js'),
      handler: 'handler',
      functionName: `e2emm-email-ingest-${stage}`,
      timeout: Duration.seconds(60),
      memorySize: 512,
      tracing: enableXRayTracing ? Tracing.ACTIVE : Tracing.DISABLED,
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
        nodeModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb'
        ],
      },
      environment: {
        RESULTS_TABLE: props.table.tableName,
        CONTRACT_ADDRESS: process.env.CA_E2E_MONITOR || '',
        EXPLORER_API_URL: process.env.EXPLORER_API_URL || 'https://api-amoy.polygonscan.com/api',
        EXPLORER_API_KEY: process.env.EXPLORER_API_KEY || '',
        RPC_ALCHEMY_URL: process.env.RPC_ALCHEMY_URL || '',
        RPC_ALCHEMY_APIKEY: process.env.RPC_ALCHEMY_APIKEY || '',
      },
    });

    // EMFをCloudWatch Logsに保存するロググループ（関数デフォルトのLGを再利用）
    const logGroup = new LogGroup(this, 'EmailIngestLogGroup', {
      logGroupName: `/aws/lambda/${this.parserFn.functionName}`,
      retention: RetentionDays.ONE_YEAR,
    });

    const s3ObjectCreatedRule = new Rule(this, 'S3ObjectCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.bucket.bucketName] },
        },
      },
    });
    s3ObjectCreatedRule.addTarget(new LambdaTarget(this.parserFn));

    props.bucket.grantRead(this.parserFn);
    // Query を実行するため Read 権限（GSI 含む）を付与
    props.table.grantReadData(this.parserFn);
    props.table.grantWriteData(this.parserFn);
    props.notificationTopic.grantPublish(this.parserFn);

    // 失敗メトリクス（EMF）に対するアラーム（カスタム名前空間は Metric で作成）
    const failuresMetric = new Metric({
      namespace: 'E2E/EmailIngest',
      metricName: 'Failures',
      statistic: 'sum',
      period: Duration.minutes(5),
      dimensionsMap: { FunctionName: this.parserFn.functionName },
    });
    const failureAlarm = new Alarm(this, 'EmailIngestFailuresAlarm', {
      metric: failuresMetric,
      threshold: 1,
      evaluationPeriods: 2, // 連続2期間（10分）でHard Failを発報
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: `${this.parserFn.functionName}--ERROR--failures`,
      alarmDescription: 'severity=ERROR: EmailIngest Failures >= 1 for 2 periods (5m each).',
    });
    failureAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    Tags.of(failureAlarm).add('severity', 'ERROR');

    // SoftMiss はTxID非含有やCorrelationId未検出など軽微な未達を集約
    const softMissMetric = new Metric({
      namespace: 'E2E/EmailIngest',
      metricName: 'SoftMiss',
      statistic: 'sum',
      period: Duration.minutes(5),
      dimensionsMap: { FunctionName: this.parserFn.functionName },
    });
    const softMissAlarm = new Alarm(this, 'EmailIngestSoftMissAlarm', {
      metric: softMissMetric,
      threshold: 3, // 5分で3件以上（=多重メール中の多数未検出）
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: `${this.parserFn.functionName}--INFO--softmiss`,
      alarmDescription: 'severity=INFO: EmailIngest SoftMiss >= 3 (5m sum).',
    });
    softMissAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    Tags.of(softMissAlarm).add('severity', 'INFO');

    // Lambda Errors (backup alarm in case EMF path misses)
    const lambdaErrorsMetric = new Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: { FunctionName: this.parserFn.functionName },
      period: Duration.minutes(5),
      statistic: 'sum',
    });
    const lambdaErrorsAlarm = new Alarm(this, 'EmailIngestLambdaErrorsAlarm', {
      metric: lambdaErrorsMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: `${this.parserFn.functionName}--WARN--failed`,
      alarmDescription: 'severity=WARN: Lambda Errors >= 1 (5m sum).',
    });
    lambdaErrorsAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    Tags.of(lambdaErrorsAlarm).add('severity', 'WARN');
  }
}


