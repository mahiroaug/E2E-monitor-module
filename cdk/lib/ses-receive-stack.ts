/**
 * SesReceiveStack
 *
 * SES 受信メールを S3（e2emm-email-bucket-<stage>）へ保存するルールを構築します。
 * 必要に応じて受信メールアドレス/ドメインを env(.env) または context から指定できます。
 *
 * context:
 * - stage          : dev|stg|prod（サフィックス）
 * - sesRuleName    : 任意。省略時は自動生成
 * - sesRecipients  : 受信アドレスの配列（例: ["monitor@example.com"]）。未指定なら全受信
 * env:
 * - SES_RECIPIENTS : カンマ区切りの受信アドレス/ドメイン（例: "a@ex.com,b@ex.com"）
 */
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { ReceiptRuleSet, ReceiptRule, ReceiptRuleProps } from 'aws-cdk-lib/aws-ses';
import { S3 } from 'aws-cdk-lib/aws-ses-actions';

export interface SesReceiveStackProps extends StackProps {
  bucket: Bucket;
}

export class SesReceiveStack extends Stack {
  constructor(scope: Construct, id: string, props: SesReceiveStackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';

    const recipientsFromEnv = (process.env.SES_RECIPIENTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const recipientsFromContext = this.node.tryGetContext('sesRecipients') as string[] | undefined;
    const recipients = (recipientsFromEnv.length > 0
      ? recipientsFromEnv
      : (Array.isArray(recipientsFromContext) ? recipientsFromContext : undefined));
    const ruleSet = new ReceiptRuleSet(this, 'E2eSesRuleSet', {
      receiptRuleSetName: `e2emm-ruleset-${stage}`,
    });

    new ReceiptRule(this, 'E2eSesToS3', {
      ruleSet,
      ruleName: `e2emm-rule-${stage}`,
      enabled: true,
      recipients: Array.isArray(recipients) && recipients.length > 0 ? recipients : undefined,
      actions: [
        new S3({
          bucket: props.bucket,
          objectKeyPrefix: `ses/${stage}/`,
        }),
      ],
    } as ReceiptRuleProps);
  }
}


