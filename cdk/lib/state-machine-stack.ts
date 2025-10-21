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
import { Alarm, ComparisonOperator, TreatMissingData, Metric, MathExpression } from 'aws-cdk-lib/aws-cloudwatch';
import { Tags } from 'aws-cdk-lib';
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

    // Stage and schedule configuration (defined early for use in metrics dimensions)
    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
    const rateFromEnv = Number(process.env.EVENT_RATE_MINUTES || '');
    const eventRateMinutes = Number.isFinite(rateFromEnv) && rateFromEnv > 0 ? Math.floor(rateFromEnv) : 180;
    const totalAttemptsFromEnv = Number(process.env.SF_TOTAL_ATTEMPTS || '');
    const totalAttemptsDefault = Number.isFinite(totalAttemptsFromEnv) && totalAttemptsFromEnv >= 1
      ? Math.floor(totalAttemptsFromEnv)
      : 3;
    const defaultTimeoutMinutes = 5 * totalAttemptsDefault + 1;
    const machineName = `e2emm-state-machine-${stage}`;

    // Attempts configuration
    const totalAttempts = totalAttemptsDefault; // default 3 attempts (1 means no retry)

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

    // Initialize DynamoDB record (create initial entry with PENDING status)
    const initRecordFn = new NodejsFunction(this, 'InitRecordFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src/lambda/init-record/index.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        RESULTS_TABLE: props.table.tableName,
      },
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
        nodeModules: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
      },
    });
    props.table.grantWriteData(initRecordFn);

    const initializeRecord = new LambdaInvoke(this, 'Initialize DDB Record', {
      lambdaFunction: initRecordFn,
      payload: TaskInput.fromObject({
        correlationId: JsonPath.stringAt('$.correlationId'),
        attempt: JsonPath.stringAt('$.attempt'),
        totalAttempts: JsonPath.stringAt('$.totalAttempts'),
      }),
      resultPath: JsonPath.DISCARD,
      payloadResponseOnly: true,
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
      time: WaitTime.duration(Duration.seconds(90)),
    });

    const getItemCorrFirst = new CallAwsService(this, 'Check DDB Item', {
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
      resultPath: '$.ddbCorr',
    });

    const success = new Succeed(this, 'Success');

    const waitRetry = new Wait(this, 'WaitAndRetry', {
      time: WaitTime.duration(Duration.seconds(15)),
    });

    const getItemCorrRetry = new CallAwsService(this, 'Check DDB Item (retry)', {
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
      resultPath: '$.ddbCorr',
    });


    // Attempt loop control (define before checkFound to avoid TDZ)
    const incAttempt = new Pass(this, 'IncrementAttempt', {
      parameters: {
        'attempt.$': 'States.MathAdd($.attempt, 1)',
        totalAttempts,
        // preserve pollCount for EmitFinalFailedMetric dimensions
        'pollCount.$': '$.pollCount',
      },
    });
    const attemptRemain = new Choice(this, 'HasAttemptsLeft?')
      .when(Condition.numberLessThanEquals('$.attempt', totalAttempts), generateCorrelationId);
    const attemptFail = new Pass(this, 'AttemptFailed');

    // Attempt-level failure metric
    // Purpose: Trigger a WARN alarm per 5-minute poll cycle failure
    // (dimensions metric AttemptFailedInfo helps triage: attempt/totalAttempts/pollCount)
    const emitAttemptFailedMetric = new CallAwsService(this, 'EmitAttemptFailedMetric', {
      service: 'cloudwatch',
      action: 'putMetricData',
      parameters: {
        Namespace: 'E2E/StateMachine',
        MetricData: [
          {
            MetricName: 'AttemptFailed',
            Unit: 'Count',
            Value: 1,
          },
          {
            MetricName: 'AttemptFailedInfo',
            Unit: 'Count',
            Value: 1,
            Dimensions: [
              { Name: 'Attempt', Value: JsonPath.format('{}', JsonPath.stringAt('$.attempt')) },
              { Name: 'TotalAttempts', Value: JsonPath.format('{}', JsonPath.stringAt('$.totalAttempts')) },
              { Name: 'PollCount', Value: JsonPath.format('{}', JsonPath.stringAt('$.pollCount')) },
            ],
          },
        ],
      },
      iamResources: ['*'],
      resultPath: JsonPath.DISCARD,
    });

    attemptFail
      .next(emitAttemptFailedMetric)
      .next(incAttempt)
      .next(attemptRemain);

    // Final failure metric then Fail state
    // Purpose: Trigger an ERROR alarm when all attempts are consumed.
    // It will auto-clear on the next successful execution.
    const emitFinalFailedMetric = new CallAwsService(this, 'EmitFinalFailedMetric', {
      service: 'cloudwatch',
      action: 'putMetricData',
      parameters: {
        Namespace: 'E2E/StateMachine',
        MetricData: [
          {
            MetricName: 'FinalFailed',
            Unit: 'Count',
            Value: 1,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'StateMachineName', Value: machineName },
            ],
          },
          {
            MetricName: 'FinalFailedInfo',
            Unit: 'Count',
            Value: 1,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'StateMachineName', Value: machineName },
              { Name: 'Attempt', Value: JsonPath.format('{}', JsonPath.stringAt('$.attempt')) },
              { Name: 'TotalAttempts', Value: JsonPath.format('{}', JsonPath.stringAt('$.totalAttempts')) },
              { Name: 'PollCount', Value: JsonPath.format('{}', JsonPath.stringAt('$.pollCount')) },
            ],
          },
        ],
      },
      iamResources: ['*'],
      resultPath: JsonPath.DISCARD,
    });
    const finalFail = new Fail(this, 'AllAttemptsFailed');
    attemptRemain.otherwise(emitFinalFailedMetric.next(finalFail));

    // Poll loop control
    // Keep pollCount and context in state (do not discard result)
    const incPoll = new Pass(this, 'IncrementPollCount', {
      parameters: {
        'pollCount.$': 'States.MathAdd($.pollCount, 1)',
        attempt: JsonPath.stringAt('$.attempt'),
        totalAttempts,
        correlationId: JsonPath.stringAt('$.correlationId'),
        messageBody: JsonPath.stringAt('$.messageBody'),
      },
    });

    const checkFound = new Choice(this, 'Found?');
    const successMode = (process.env.SF_SUCCESS_MODE || 'and').toLowerCase();
    // NOTE: DDB boolean attributes appear as 'Bool' in Step Functions output.
    // Combine presence + equality checks to avoid invalid path when Item is missing.
    const corrResolved = Condition.and(
      Condition.isPresent('$.ddbCorr.Item.correlationResolved.Bool'),
      Condition.booleanEquals('$.ddbCorr.Item.correlationResolved.Bool', true),
    );
    const balanceReceived = Condition.and(
      Condition.isPresent('$.ddbCorr.Item.balanceReceived.Bool'),
      Condition.booleanEquals('$.ddbCorr.Item.balanceReceived.Bool', true),
    );

    const loopAfterRetry = waitRetry
      .next(getItemCorrRetry)
      .next(checkFound);

    // Emit Success metric right before completing the execution
    // Purpose: Enable auto-clear of WARN/ERROR using math expressions over time windows
    const emitSuccessMetric = new CallAwsService(this, 'EmitSuccessMetric', {
      service: 'cloudwatch',
      action: 'putMetricData',
      parameters: {
        Namespace: 'E2E/StateMachine',
        MetricData: [
          {
            MetricName: 'Success',
            Unit: 'Count',
            Value: 1,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'StateMachineName', Value: machineName },
            ],
          },
        ],
      },
      iamResources: ['*'],
      resultPath: JsonPath.DISCARD,
    });

    if (successMode === 'correlation') {
      checkFound
        .when(corrResolved, emitSuccessMetric.next(success))
        .otherwise(
          incPoll.next(
            new Choice(this, 'PollLimitReached?')
              .when(Condition.numberGreaterThanEquals('$.pollCount', 14), attemptFail)
              .otherwise(loopAfterRetry)
          )
        );
    } else if (successMode === 'balance') {
      checkFound
        .when(balanceReceived, emitSuccessMetric.next(success))
        .otherwise(
          incPoll.next(
            new Choice(this, 'PollLimitReached?')
              .when(Condition.numberGreaterThanEquals('$.pollCount', 14), attemptFail)
              .otherwise(loopAfterRetry)
          )
        );
    } else {
      // default 'and' mode
      checkFound
        .when(Condition.and(corrResolved, balanceReceived), emitSuccessMetric.next(success))
        .otherwise(
          incPoll.next(
            new Choice(this, 'PollLimitReached?')
              .when(Condition.numberGreaterThanEquals('$.pollCount', 14), attemptFail)
              .otherwise(loopAfterRetry)
          )
        );
    }

    const logGroup = new LogGroup(this, 'StateMachineLogs', {
      retention: RetentionDays.ONE_YEAR,
    });
    // timeoutMinutes is already computed above using totalAttemptsDefault
    // keep using totalAttempts for state machine timeout logic
    const timeoutMinutes = 5 * totalAttempts + 1;

    // Heartbeat: ステートマシン起動時に 1 を送信
    const emitHeartbeatMetric = new CallAwsService(this, 'EmitHeartbeatMetric', {
      service: 'cloudwatch',
      action: 'putMetricData',
      parameters: {
        Namespace: 'E2E/Heartbeat',
        MetricData: [
          {
            MetricName: 'heartbeat',
            Unit: 'Count',
            Value: 1,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Component', Value: 'statemachine' },
            ],
          },
        ],
      },
      iamResources: ['*'],
      resultPath: JsonPath.DISCARD,
    });
    this.machine = new StateMachine(this, 'E2eMachine', {
      stateMachineName: machineName,
      definition: initAttempts
        .next(emitHeartbeatMetric)
        .next(generateCorrelationId)
        .next(initializeRecord)      // ← 初期レコード作成を追加
        .next(setDefaultTagSeed)
        .next(prepareMessage)
        .next(adoptPreparedValues)
        .next(sendMessage)
        .next(waitStart)
        .next(getItemCorrFirst)
        .next(checkFound),
      timeout: Duration.minutes(timeoutMinutes),
      logs: {
        destination: logGroup,
        level: LogLevel.ALL,
      } as LogOptions,
    });

    props.queue.grantSendMessages(this.machine);
    props.table.grantReadData(this.machine);
    props.table.grantWriteData(this.machine);  // ← 初期レコード作成用の権限追加

    // Alarms: AttemptFailed (WARN), FinalFailed (ERROR)
    // WARNは「成功するまで維持」するため、評価ウィンドウを再試行間隔(5分)＋バタ付き防止(1分)の6分で設定
    const attemptFailedWindow = new Metric({
      namespace: 'E2E/StateMachine',
      metricName: 'AttemptFailed',
      period: Duration.minutes(6),
      statistic: 'sum',
    });
    const successWindowWarn = new Metric({
      namespace: 'E2E/StateMachine',
      metricName: 'Success',
      period: Duration.minutes(6),
      statistic: 'sum',
    });
    const warnExprWindow = new MathExpression({
      expression: 'af - s',
      usingMetrics: { af: attemptFailedWindow, s: successWindowWarn },
      period: Duration.minutes(6),
    });
    const warnAttemptAlarm = new Alarm(this, 'AttemptFailedWarn', {
      metric: warnExprWindow,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmName: `${this.machine.stateMachineName}--WARN--attempt-failed`,
      alarmDescription: 'severity=WARN: Attempt failed (auto-OK on next success within 6 minutes).',
    });
    warnAttemptAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    warnAttemptAlarm.addOkAction(new SnsAction(props.notificationTopic));
    Tags.of(warnAttemptAlarm).add('severity', 'WARN');

    const finalFailedMetric = new Metric({
      namespace: 'E2E/StateMachine',
      metricName: 'FinalFailed',
      period: Duration.minutes(5),
      statistic: 'sum',
    });
    const recoveryWindowMinutes = eventRateMinutes + 3;
    const successWindow = new Metric({
      namespace: 'E2E/StateMachine',
      metricName: 'Success',
      period: Duration.minutes(recoveryWindowMinutes),
      statistic: 'sum',
      dimensionsMap: { Stage: stage, StateMachineName: machineName },
    });
    const finalFailedWindow = new Metric({
      namespace: 'E2E/StateMachine',
      metricName: 'FinalFailed',
      period: Duration.minutes(recoveryWindowMinutes),
      statistic: 'sum',
      dimensionsMap: { Stage: stage, StateMachineName: machineName },
    });
    const errorExpr = new MathExpression({
      expression: 'ff - s',
      usingMetrics: { ff: finalFailedWindow, s: successWindow },
      period: Duration.minutes(recoveryWindowMinutes),
    });
    const errorAlarm = new Alarm(this, 'StateMachineFailedError', {
      metric: errorExpr,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmName: `${this.machine.stateMachineName}--ERROR--final-failed`,
      alarmDescription: 'severity=ERROR: Final failure (auto-OK on next success within window).',
    });
    errorAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    errorAlarm.addOkAction(new SnsAction(props.notificationTopic));
    Tags.of(errorAlarm).add('severity', 'ERROR');

    // Heartbeat missed アラーム（ウォッチドッグ）
    // 1分粒度で EVENT_RATE_MINUTES+3 連続で欠損/0 なら ALARM（= どこか1分でも 1 が出れば即OK）
    const heartbeatMetric = new Metric({
      namespace: 'E2E/Heartbeat',
      metricName: 'heartbeat',
      period: Duration.minutes(1),
      statistic: 'sum',
      dimensionsMap: { Stage: stage, Component: 'statemachine' },
    });
    const heartbeatMissedAlarm = new Alarm(this, 'StateMachineHeartbeatMissed', {
      metric: heartbeatMetric,
      threshold: 1,
      evaluationPeriods: eventRateMinutes + 3,
      datapointsToAlarm: eventRateMinutes + 3,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
      alarmName: `${this.machine.stateMachineName}--ERROR--heartbeat-missed`,
      alarmDescription: 'severity=ERROR: No heartbeat for EVENT_RATE_MINUTES+3 minutes.',
    });
    heartbeatMissedAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    heartbeatMissedAlarm.addOkAction(new SnsAction(props.notificationTopic));
    Tags.of(heartbeatMissedAlarm).add('severity', 'ERROR');

    // AttemptFailed パルスアラーム（1分ごとにAttemptFailedが発生したら単発通知）
    const attemptFailedPulse = new Metric({
      namespace: 'E2E/StateMachine',
      metricName: 'AttemptFailed',
      period: Duration.minutes(1),
      statistic: 'sum',
    });
    const attemptFailedPulseAlarm = new Alarm(this, 'AttemptFailedPulseWarn', {
      metric: attemptFailedPulse,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmName: `${this.machine.stateMachineName}--WARN--attempt-failed-pulse`,
      alarmDescription: 'severity=WARN: AttemptFailed >= 1 (1m sum). Single-shot pulse per minute.',
    });
    attemptFailedPulseAlarm.addAlarmAction(new SnsAction(props.notificationTopic));
    Tags.of(attemptFailedPulseAlarm).add('severity', 'WARN');

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


