#!/usr/bin/env node
import 'source-map-support/register';
import 'dotenv/config';
import { App } from 'aws-cdk-lib';
import { EmailIngestStack } from '../lib/email-ingest-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { StorageStack } from '../lib/storage-stack';
import { NotificationStack } from '../lib/notification-stack';
import { StateMachineStack } from '../lib/state-machine-stack';
import { SsmParametersStack } from '../lib/ssm-parameters-stack';

/**
 * CDK App エントリ
 *
 * 読み込まれる環境変数（.env / 環境）
 * - STAGE                : デプロイステージ（dev|stg|prod）。context 'stage' が優先
 * - CDK_DEFAULT_ACCOUNT  : CDK既定アカウント（任意）
 * - CDK_DEFAULT_REGION   : CDK既定リージョン（任意）
 *
 * 備考:
 * - dotenv を先に読み込んだ上で App を初期化します。
 */

const app = new App();
const stage = app.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';

const ssm = new SsmParametersStack(app, `e2emm-stack-ssm-${stage}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
const storage = new StorageStack(app, `e2emm-stack-storage-${stage}`);
const messaging = new MessagingStack(app, `e2emm-stack-messaging-${stage}`);
const notification = new NotificationStack(app, `e2emm-stack-notification-${stage}`);

new EmailIngestStack(app, `e2emm-stack-email-ingest-${stage}`, {
  bucket: storage.bucket,
  notificationTopic: notification.topic,
  table: storage.table,
});

new StateMachineStack(app, `e2emm-stack-statemachine-${stage}`, {
  queue: messaging.queue,
  table: storage.table,
  notificationTopic: notification.topic,
});


