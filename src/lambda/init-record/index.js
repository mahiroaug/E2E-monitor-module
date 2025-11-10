/**
 * init-record Lambda
 *
 * 役割: Step Functions開始時にDynamoDBへ初期レコードを作成
 * 入力: { correlationId: string, correlationIdHex?: string, attempt: number, totalAttempts: number }
 * 出力: { ok: boolean, created?: boolean, updated?: boolean }
 */
'use strict';

const { createHash } = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const RESULTS_TABLE = process.env.RESULTS_TABLE || '';

/**
 * UNIX timestamp (ms) から UTC/JST/ms の3フィールドを生成
 */
function makeTimestampFields(epochMs, prefix) {
  const date = new Date(epochMs);

  // UTC ISO8601
  const utc = date.toISOString();

  // JST (UTC+9)
  const jstDate = new Date(epochMs + 9 * 60 * 60 * 1000);
  const jst = jstDate.toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ''); // "2025-10-21 21:00:00"

  return {
    [`${prefix}Ms`]: epochMs,
    [`${prefix}`]: utc,
    [`${prefix}JST`]: jst,
  };
}

exports.handler = async (event) => {
  if (!RESULTS_TABLE) {
    throw new Error('Missing RESULTS_TABLE environment variable');
  }

  const correlationId = event.correlationId;
  const attempt = event.attempt || 1;
  const totalAttempts = event.totalAttempts || 3;
  const nowMs = Date.now();

  // correlationIdHexが渡されない場合は、correlationIdからSHA256ハッシュを生成
  const correlationIdHex = event.correlationIdHex ||
    `0x${createHash('sha256').update(correlationId).digest('hex')}`;

  const createdFields = makeTimestampFields(nowMs, 'createdAt');
  const updatedFields = makeTimestampFields(nowMs, 'updatedAt');

  // TTL: 5年後のUnixタイムスタンプ（秒単位）
  // 5年 = 5 * 365 * 24 * 60 * 60 = 157,680,000秒
  const TTL_SECONDS_5_YEARS = 5 * 365 * 24 * 60 * 60;
  const ttl = Math.floor(nowMs / 1000) + TTL_SECONDS_5_YEARS;

  const item = {
    correlationId,
    correlationIdHex,  // hash値も保存
    recordType: 'E2E_TASK',
    ...createdFields,
    attempt,
    totalAttempts,
    status: 'PENDING',
    correlationResolved: false,
    balanceReceived: false,
    ...updatedFields,
    ttl, // TTL属性（5年後に自動削除）
  };

  try {
    // ConditionExpression: correlationIdが存在しない場合のみ作成
    await ddb.send(new PutCommand({
      TableName: RESULTS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(correlationId)',
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Initial record created',
      correlationId,
      attempt,
      createdAtJST: createdFields.createdAtJST,
    }));

    return { ok: true, created: true };

  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      // 既存レコードが存在 → attempt更新のみ
      console.log(JSON.stringify({
        level: 'warn',
        message: 'CorrelationId already exists, updating attempt',
        correlationId,
        attempt,
      }));

      // 既存レコードを取得してcreatedAtMsからttlを計算
      const existingRecord = await ddb.send(new GetCommand({
        TableName: RESULTS_TABLE,
        Key: { correlationId },
      }));

      const existingCreatedAtMs = existingRecord.Item?.createdAtMs || nowMs;
      // TTL: createdAtMsから5年後のUnixタイムスタンプ（秒単位）
      const TTL_SECONDS_5_YEARS = 5 * 365 * 24 * 60 * 60;
      const ttl = Math.floor(existingCreatedAtMs / 1000) + TTL_SECONDS_5_YEARS;

      await ddb.send(new UpdateCommand({
        TableName: RESULTS_TABLE,
        Key: { correlationId },
        UpdateExpression: `
          SET attempt = :attempt,
              totalAttempts = :totalAttempts,
              updatedAtMs = :updMs,
              updatedAt = :updUtc,
              updatedAtJST = :updJst,
              #ttl = :ttl
        `,
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':attempt': attempt,
          ':totalAttempts': totalAttempts,
          ':updMs': updatedFields.updatedAtMs,
          ':updUtc': updatedFields.updatedAt,
          ':updJst': updatedFields.updatedAtJST,
          ':ttl': ttl,
        },
      }));

      console.log(JSON.stringify({
        level: 'info',
        message: 'Attempt updated',
        correlationId,
        attempt,
      }));

      return { ok: true, created: false, updated: true };
    }

    console.error(JSON.stringify({
      level: 'error',
      message: 'Failed to create/update initial record',
      correlationId,
      error: e && e.message ? e.message : String(e),
    }));
    throw e;
  }
};

