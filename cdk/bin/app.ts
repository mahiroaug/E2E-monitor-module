#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { EmailIngestStack } from '../lib/email-ingest-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { StorageStack } from '../lib/storage-stack';
import { NotificationStack } from '../lib/notification-stack';
import { StateMachineStack } from '../lib/state-machine-stack';

const app = new App();

const storage = new StorageStack(app, 'E2eStorageStack');
const messaging = new MessagingStack(app, 'E2eMessagingStack');
const notification = new NotificationStack(app, 'E2eNotificationStack');

new EmailIngestStack(app, 'E2eEmailIngestStack', {
  bucket: storage.bucket,
  notificationTopic: notification.topic,
  table: storage.table,
});

new StateMachineStack(app, 'E2eStateMachineStack', {
  queue: messaging.queue,
  table: storage.table,
  notificationTopic: notification.topic,
});


