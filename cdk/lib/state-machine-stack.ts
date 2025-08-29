import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { StateMachine, LogLevel, JsonPath, Wait, WaitTime, LogOptions, Choice, Condition, Succeed } from 'aws-cdk-lib/aws-stepfunctions';
import { CallAwsService } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';

export interface StateMachineStackProps extends StackProps {
  queue: Queue;
  table: Table;
  notificationTopic: Topic;
}

export class StateMachineStack extends Stack {
  public readonly machine: StateMachine;

  constructor(scope: Construct, id: string, props: StateMachineStackProps) {
    super(scope, id, props);

    const sendMessage = new CallAwsService(this, 'Send SQS Message', {
      service: 'sqs',
      action: 'sendMessage',
      parameters: {
        QueueUrl: props.queue.queueUrl,
        MessageBody: JsonPath.stringAt('$.messageBody'),
      },
      iamResources: ['*'],
    });

    const waitStart = new Wait(this, 'WaitForEmail', {
      time: WaitTime.duration(Duration.seconds(15)),
    });

    const getItemFirst = new CallAwsService(this, 'Check DDB Result', {
      service: 'dynamodb',
      action: 'getItem',
      parameters: {
        TableName: props.table.tableName,
        Key: {
          correlationId: { 'S.$': JsonPath.stringAt('$.correlationId') },
        },
        ConsistentRead: true,
      },
      iamResources: ['*'],
      resultPath: '$.ddb',
    });

    const success = new Succeed(this, 'Success');

    const waitRetry = new Wait(this, 'WaitAndRetry', {
      time: WaitTime.duration(Duration.seconds(15)),
    });

    const getItemRetry = new CallAwsService(this, 'Check DDB Result (retry)', {
      service: 'dynamodb',
      action: 'getItem',
      parameters: {
        TableName: props.table.tableName,
        Key: {
          correlationId: { 'S.$': JsonPath.stringAt('$.correlationId') },
        },
        ConsistentRead: true,
      },
      iamResources: ['*'],
      resultPath: '$.ddb',
    });

    const checkFound = new Choice(this, 'Found?');
    checkFound
      .when(Condition.isPresent('$.ddb.Item'), success)
      .otherwise(waitRetry.next(getItemRetry).next(checkFound));

    const logGroup = new LogGroup(this, 'StateMachineLogs', {
      retention: RetentionDays.ONE_WEEK,
    });

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    this.machine = new StateMachine(this, 'E2eMachine', {
      stateMachineName: `e2emm-state-machine-${stage}`,
      definition: sendMessage.next(waitStart).next(getItemFirst).next(checkFound),
      timeout: Duration.minutes(5),
      logs: {
        destination: logGroup,
        level: LogLevel.ALL,
      } as LogOptions,
    });

    props.queue.grantSendMessages(this.machine);
    props.table.grantReadData(this.machine);

    // Alarm on failed executions -> SNS
    const failedMetric = this.machine.metricFailed();
    const alarm = new Alarm(this, 'StateMachineFailedAlarm', {
      metric: failedMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new SnsAction(props.notificationTopic));

    // EventBridge schedule (disabled by default - input requires correlationIdHex32/tagHex32)
    const rule = new Rule(this, 'E2eScheduleRule', {
      schedule: Schedule.rate(Duration.minutes(5)),
      enabled: false,
    });
    rule.addTarget(new SfnStateMachine(this.machine, {
      input: RuleTargetInput.fromObject({
        // NOTE: Replace these fields or trigger manually with proper input
        correlationId: 'REPLACE_WITH_CORRELATION_ID_KEY',
        messageBody: JSON.stringify({
          correlationIdHex32: '0x' + 'a'.repeat(64),
          tagHex32: '0x' + 'b'.repeat(64)
        })
      }),
    }));
  }
}


