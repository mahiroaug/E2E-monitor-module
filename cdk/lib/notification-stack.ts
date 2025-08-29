import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Topic } from 'aws-cdk-lib/aws-sns';

export class NotificationStack extends Stack {
  public readonly topic: Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    this.topic = new Topic(this, 'AlertsTopic', {
      topicName: `e2emm-alerts-${stage}`,
    });
  }
}


