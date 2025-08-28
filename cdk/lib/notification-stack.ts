import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Topic } from 'aws-cdk-lib/aws-sns';

export class NotificationStack extends Stack {
  public readonly topic: Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.topic = new Topic(this, 'AlertsTopic');
  }
}


