import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
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
    this.parserFn = new NodejsFunction(this, 'EmailParserFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/email-ingest/index.js'),
      handler: 'handler',
      functionName: `e2emm-email-ingest-${stage}`,
      timeout: Duration.seconds(60),
      memorySize: 512,
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
      },
    });

    // EMFをCloudWatch Logsに保存するロググループ（関数デフォルトのLGを再利用）
    const logGroup = new LogGroup(this, 'EmailIngestLogGroup', {
      logGroupName: `/aws/lambda/${this.parserFn.functionName}`,
      retention: RetentionDays.ONE_WEEK,
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
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    failureAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
  }
}


