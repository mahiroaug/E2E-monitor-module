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

export interface EmailIngestStackProps extends StackProps {
  bucket: Bucket;
  notificationTopic: Topic;
  table: Table;
}

export class EmailIngestStack extends Stack {
  public readonly parserFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: EmailIngestStackProps) {
    super(scope, id, props);

    this.parserFn = new NodejsFunction(this, 'EmailParserFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/email-ingest/index.js'),
      handler: 'handler',
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
  }
}


