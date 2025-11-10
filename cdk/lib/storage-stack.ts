/**
 * StorageStack
 *
 * 本スタックで参照される設定:
 * - context 'stage'（dev|stg|prod）: 物理名サフィックスに使用
 *
 * 本スタック内で process.env から直接読み込む環境変数はありません。
 */
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AttributeType, BillingMode, Table, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';

export class StorageStack extends Stack {
  public readonly bucket: Bucket;
  public readonly table: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    this.bucket = new Bucket(this, 'EmailBucket', {
      bucketName: `e2emm-email-bucket-${stage}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      eventBridgeEnabled: true,
    });

    this.table = new Table(this, 'ResultsTable', {
      tableName: `e2emm-results-${stage}`,
      partitionKey: { name: 'correlationId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl', // TTL属性を有効化（5年後に自動削除）
    });

    // GSI for all records in time order (newest first)
    // Used for: Console display, balance notification attachment
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI_TimeOrder',
      partitionKey: { name: 'recordType', type: AttributeType.STRING },
      sortKey: { name: 'createdAtMs', type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });

    // GSI for time-window correlation (query by eventBucket + eventEmailAtMs)
    // Legacy: Used as fallback for balance notification
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1_EventTime',
      partitionKey: { name: 'eventBucket', type: AttributeType.STRING },
      sortKey: { name: 'eventEmailAtMs', type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });
  }
}


