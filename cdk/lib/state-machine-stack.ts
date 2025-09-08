/**
 * StateMachineStack
 *
 * 本スタックで参照される設定:
 * - context 'stage'（dev|stg|prod）: ステートマシン名サフィックス
 * - EventBridge ルールは論理名のみ（必要に応じて ruleName 付与可）
 */
import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { StateMachine, LogLevel, JsonPath, Wait, WaitTime, LogOptions, Choice, Condition, Succeed, Pass, Fail } from 'aws-cdk-lib/aws-stepfunctions';
import { CallAwsService, LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { TaskInput } from 'aws-cdk-lib/aws-stepfunctions';
import { join } from 'path';

export interface StateMachineStackProps extends StackProps {
  queue: Queue;
  table: Table;
  notificationTopic: Topic;
}

export class StateMachineStack extends Stack {
  public readonly machine: StateMachine;

  constructor(scope: Construct, id: string, props: StateMachineStackProps) {
    super(scope, id, props);

    // Attempts configuration
    const totalAttemptsFromEnv = Number(process.env.SF_TOTAL_ATTEMPTS || '');
    const totalAttempts = Number.isFinite(totalAttemptsFromEnv) && totalAttemptsFromEnv >= 1
      ? Math.floor(totalAttemptsFromEnv)
      : 3; // default 3 attempts (1 means no retry)

    // Initialize attempts/poll counter
    const initAttempts = new Pass(this, 'InitAttempts', {
      parameters: {
        attempt: 1,
        totalAttempts,
        pollCount: 0,
      },
    });


    const resetPollCount = new Pass(this, 'ResetPollCount', {
      parameters: {
        attempt: JsonPath.stringAt('$.attempt'),
        totalAttempts,
        pollCount: 0,
      },
    });

    // Generate new correlationId (ignore input for each attempt)
    const generateCorrelationId = new Pass(this, 'GenerateCorrelationId', {
      parameters: {
        correlationId: JsonPath.uuid(),
        attempt: JsonPath.stringAt('$.attempt'),
        totalAttempts,
        pollCount: 0,
      },
    });

    // Prepare message body (build bytes32 values) via Lambda
    const prepareMessageFn = new NodejsFunction(this, 'PrepareMessageFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/prepare-message/index.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling: { minify: true, externalModules: ['aws-sdk'] },
    });

    const prepareMessage = new LambdaInvoke(this, 'PrepareMessage', {
      lambdaFunction: prepareMessageFn,
      payload: TaskInput.fromObject({
        correlationId: JsonPath.stringAt('$.correlationId'),
        tagSeed: JsonPath.stringAt('$.tagSeed'),
      }),
      resultPath: '$.prep',
      payloadResponseOnly: true,
    });

    // Ensure tagSeed exists (fallback to default when missing)
    const setDefaultTagSeed = new Pass(this, 'SetDefaultTagSeed', {
      parameters: {
        // Use attempt number as tag seed ("1", "2", ...)
        tagSeed: JsonPath.stringAt('$.attempt'),
        correlationId: JsonPath.stringAt('$.correlationId'),
        attempt: JsonPath.stringAt('$.attempt'),
        totalAttempts,
        pollCount: JsonPath.stringAt('$.pollCount'),
      },
    });

    // Adopt hex32 into root correlationId and messageBody from prep
    const adoptPreparedValues = new Pass(this, 'AdoptPreparedValues', {
      parameters: {
        correlationId: JsonPath.stringAt('$.prep.correlationIdHex32'),
        messageBody: JsonPath.stringAt('$.prep.messageBody'),
        attempt: JsonPath.stringAt('$.attempt'),
        totalAttempts,
        pollCount: JsonPath.stringAt('$.pollCount'),
      },
    });

    // NOTE: For DynamoDB AttributeValue, avoid nested '.$' by using intrinsic formatting

    const sendMessage = new CallAwsService(this, 'Send SQS Message', {
      service: 'sqs',
      action: 'sendMessage',
      parameters: {
        QueueUrl: props.queue.queueUrl,
        MessageBody: JsonPath.stringAt('$.messageBody'),
      },
      iamResources: ['*'],
      resultPath: JsonPath.DISCARD,
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
          correlationId: {
            S: JsonPath.format('{}', JsonPath.stringAt('$.correlationId')),
          },
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
          correlationId: {
            S: JsonPath.format('{}', JsonPath.stringAt('$.correlationId')),
          },
        },
        ConsistentRead: true,
      },
      iamResources: ['*'],
      resultPath: '$.ddb',
    });

    // Attempt loop control (define before checkFound to avoid TDZ)
    const failState = new Fail(this, 'AllAttemptsFailed');
    const incAttempt = new Pass(this, 'IncrementAttempt', {
      parameters: {
        'attempt.$': 'States.MathAdd($.attempt, 1)',
        totalAttempts,
      },
    });
    const attemptRemain = new Choice(this, 'HasAttemptsLeft?')
      .when(Condition.numberLessThanEquals('$.attempt', totalAttempts), generateCorrelationId)
      .otherwise(failState);
    const attemptFail = new Pass(this, 'AttemptFailed');
    attemptFail.next(incAttempt).next(attemptRemain);

    // Poll loop control
    const incPoll = new Pass(this, 'IncrementPollCount', {
      parameters: {
        'pollCount.$': 'States.MathAdd($.pollCount, 1)',
        'attempt.$': JsonPath.stringAt('$.attempt'),
        totalAttempts,
        'correlationId.$': JsonPath.stringAt('$.correlationId'),
        'messageBody.$': JsonPath.stringAt('$.messageBody'),
        'ddb.$': JsonPath.stringAt('$.ddb'),
      },
      resultPath: JsonPath.DISCARD,
    });

    const checkFound = new Choice(this, 'Found?');
    const loopAfterRetry = waitRetry.next(getItemRetry).next(checkFound);
    checkFound
      .when(Condition.isPresent('$.ddb.Item'), success)
      .otherwise(
        incPoll.next(
          new Choice(this, 'PollLimitReached?')
            .when(Condition.numberGreaterThanEquals('$.pollCount', 20), attemptFail)
            .otherwise(loopAfterRetry)
        )
      );

    const logGroup = new LogGroup(this, 'StateMachineLogs', {
      retention: RetentionDays.ONE_YEAR,
    });

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    const rateFromEnv = Number(process.env.EVENT_RATE_MINUTES || '');
    const eventRateMinutes = Number.isFinite(rateFromEnv) && rateFromEnv > 0 ? Math.floor(rateFromEnv) : 180;
    const timeoutMinutes = 5 * totalAttempts + 1;
    this.machine = new StateMachine(this, 'E2eMachine', {
      stateMachineName: `e2emm-state-machine-${stage}`,
      definition: initAttempts
        .next(generateCorrelationId)
        .next(setDefaultTagSeed)
        .next(prepareMessage)
        .next(adoptPreparedValues)
        .next(sendMessage)
        .next(waitStart)
        .next(getItemFirst)
        .next(checkFound),
      timeout: Duration.minutes(timeoutMinutes),
      logs: {
        destination: logGroup,
        level: LogLevel.ALL,
      } as LogOptions,
    });

    props.queue.grantSendMessages(this.machine);
    props.table.grantReadData(this.machine);

    // Alarms on failed executions -> SNS
    const failed5m = this.machine.metricFailed({ period: Duration.minutes(5), statistic: 'sum' });
    // WARN: 5分で1回失敗
    const warnAlarm = new Alarm(this, 'StateMachineFailedWarn', {
      metric: failed5m,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    warnAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    // ERROR: 15分で3回連続失敗（5分x3）
    const errorAlarm = new Alarm(this, 'StateMachineFailedError', {
      metric: failed5m,
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    errorAlarm.addAlarmAction(new SnsAction(props.notificationTopic));

    // EventBridge schedule (disabled by default - input requires correlationIdHex32/tagHex32)
    const rule = new Rule(this, 'E2eScheduleRule', {
      schedule: Schedule.rate(Duration.minutes(eventRateMinutes)),
      enabled: true,
    });
    rule.addTarget(new SfnStateMachine(this.machine, {
      // 入力不要（State Machine 内でUUID/既定tagSeedを生成）
      input: RuleTargetInput.fromObject({}),
    }));
  }
}


