#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { EmailIngestStack } from '../lib/email-ingest-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { StorageStack } from '../lib/storage-stack';
import { NotificationStack } from '../lib/notification-stack';
import { StateMachineStack } from '../lib/state-machine-stack';

const app = new App();
const stage = app.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';

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


