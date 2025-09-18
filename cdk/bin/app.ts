#!/usr/bin/env node
import 'source-map-support/register';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { App } from 'aws-cdk-lib';
import { EmailIngestStack } from '../lib/email-ingest-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { StorageStack } from '../lib/storage-stack';
import { NotificationStack } from '../lib/notification-stack';
import { StateMachineStack } from '../lib/state-machine-stack';
import { SesReceiveStack } from '../lib/ses-receive-stack';

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

// Load environment variables from root/.env, cdk/.env and stage-specific .env files
dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config({ path: resolve(process.cwd(), '.env') });
const stageFromCtx = process.env.STAGE || 'dev';
// load stage-specific env from project root and cdk dir if exists
dotenv.config({ path: resolve(process.cwd(), `../.env_${stageFromCtx}`) });
dotenv.config({ path: resolve(process.cwd(), `.env_${stageFromCtx}`) });

const app = new App();
const stage = app.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const envOptional = (account && region) ? { env: { account, region } } : {};

const storage = new StorageStack(app, `e2emm-stack-storage-${stage}`, { ...envOptional });
const notification = new NotificationStack(app, `e2emm-stack-notification-${stage}`, { ...envOptional });
const messaging = new MessagingStack(app, `e2emm-stack-messaging-${stage}`, { ...envOptional, notificationTopic: notification.topic });

// SES 受信→S3 保存
new SesReceiveStack(app, `e2emm-stack-ses-receive-${stage}`, {
  ...envOptional,
  bucket: storage.bucket,
});

new EmailIngestStack(app, `e2emm-stack-email-ingest-${stage}`, {
  ...envOptional,
  bucket: storage.bucket,
  notificationTopic: notification.topic,
  table: storage.table,
});

new StateMachineStack(app, `e2emm-stack-statemachine-${stage}`, {
  ...envOptional,
  queue: messaging.queue,
  table: storage.table,
  notificationTopic: notification.topic,
});


