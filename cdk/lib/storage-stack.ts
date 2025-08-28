import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';

export class StorageStack extends Stack {
  public readonly bucket: Bucket;
  public readonly table: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, 'EmailBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      eventBridgeEnabled: true,
    });

    this.table = new Table(this, 'ResultsTable', {
      partitionKey: { name: 'correlationId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}


