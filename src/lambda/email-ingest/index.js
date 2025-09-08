/**
 * email-ingest Lambda
 *
 * 役割: S3に保存された受信メールからTxHashを抽出し、エクスプローラAPIで
 *       E2ePingイベントを照会して correlationId を取得。DynamoDBに結果を記録し、
 *       失敗時はEMFメトリクスを出力してアラーム連携する。
 * トリガー: EventBridge（S3 Object Created for email bucket）
 * 出力: DynamoDB `e2emm-results-<stage>` に upsert（キー: correlationId）
 */
'use strict';

// 環境変数
const RESULTS_TABLE = process.env.RESULTS_TABLE || '';
const EXPLORER_API_URL = process.env.EXPLORER_API_URL || '';
const EXPLORER_API_KEY = process.env.EXPLORER_API_KEY || '';
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS || '').toLowerCase();
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ロガー（JSON一貫出力）
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level) {
  const lv = LEVELS[level] || LEVELS.info;
  const cur = LEVELS[LOG_LEVEL] || LEVELS.info;
  return lv >= cur;
}
function log(level, message, details) {
  if (!shouldLog(level)) return;
  const rec = { level, message, details: details || undefined, timestamp: new Date().toISOString() };
  if (level === 'error') console.error(JSON.stringify(rec));
  else if (level === 'warn') console.warn(JSON.stringify(rec));
  else console.log(JSON.stringify(rec));
}
const logger = {
  debug: (m, d) => log('debug', m, d),
  info: (m, d) => log('info', m, d),
  warn: (m, d) => log('warn', m, d),
  error: (m, d) => log('error', m, d),
};

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// CloudWatch Embedded Metric Format (EMF)
function emitMetric(metricName, reason) {
  try {
    const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'email-ingest';
    const metricPayload = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'E2E/EmailIngest',
            Dimensions: [['FunctionName']],
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
          {
            Namespace: 'E2E/EmailIngest',
            Dimensions: [['FunctionName', 'Reason']],
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      FunctionName: functionName,
      Reason: reason,
      [metricName]: 1,
    };
    console.log(JSON.stringify(metricPayload));
  } catch (e) {
    // メトリクス出力失敗時も処理は継続
    logger.warn('emitFailureMetric error', { error: e && e.message ? e.message : String(e) });
  }
}

// 簡易 quoted-printable デコード（最低限）
function decodeQuotedPrintable(input) {
  if (!input) return '';
  // soft line breaks =\r?\n を除去
  let s = input.replace(/=\r?\n/g, '');
  // =XX をバイトに変換
  s = s.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return s;
}

function extractTxHashFromText(text) {
  if (!text) return null;
  // 1) エクスプローラURLの末尾（最優先）
  const url = text.match(/https?:\/\/\S*?\/tx\/0x[a-fA-F0-9]{64}/);
  if (url) {
    const m = url[0].match(/0x[a-fA-F0-9]{64}/);
    if (m) return m[0];
  }
  // 2) ラベル付き "TxID: 0x..."（テキスト本文）
  const labeled = text.match(/TxID\s*:\s*(0x[a-fA-F0-9]{64})/i);
  if (labeled) return labeled[1];
  // 3) 直接 0x64桁（最後の手段。EventIDなどの誤拾いの可能性）
  const direct = text.match(/0x[a-fA-F0-9]{64}/);
  if (direct) return direct[0];
  return null;
}

async function fetchReceiptFromExplorer(txHash) {
  const url = new URL(EXPLORER_API_URL);
  // Polygonscan 互換の proxy API
  url.searchParams.set('module', 'proxy');
  url.searchParams.set('action', 'eth_getTransactionReceipt');
  url.searchParams.set('txhash', txHash);
  if (EXPLORER_API_KEY) url.searchParams.set('apikey', EXPLORER_API_KEY);
  // デバッグ用にAPI呼び出しの概要を出力（キーは出さない）
  logger.debug('Explorer request', {
    base: EXPLORER_API_URL,
    module: 'proxy',
    action: 'eth_getTransactionReceipt',
    txhash: txHash,
  });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Explorer API error: ${res.status}`);
  const body = await res.json();
  if (!body || !body.result) throw new Error('Invalid explorer response');
  return body.result;
}


function extractCorrelationIdFromLogs(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const targetLogs = receipt.logs.filter((l) => (l.address || '').toLowerCase() === CONTRACT_ADDRESS);
  if (targetLogs.length === 0) return null;
  for (const log of targetLogs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics.length >= 2 && /^0x[0-9a-fA-F]{64}$/.test(topics[1])) {
      return topics[1];
    }
  }
  return null;
}

async function putResultItem(correlationId, txHash) {
  const item = {
    correlationId,
    status: 'SUCCESS',
    txHash,
    receivedAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: RESULTS_TABLE, Item: item }));
}

function extractS3Events(evt) {
  const out = [];
  // S3 Event Notification (Records[])
  if (Array.isArray(evt?.Records) && evt.Records.length > 0) {
    for (const r of evt.Records) {
      if (r?.s3?.bucket?.name && r?.s3?.object?.key) {
        out.push({ bucket: r.s3.bucket.name, key: r.s3.object.key });
      }
    }
  }
  // EventBridge S3 event (source=aws.s3)
  if (evt?.source === 'aws.s3' && evt?.detail?.bucket?.name && evt?.detail?.object?.key) {
    out.push({ bucket: evt.detail.bucket.name, key: evt.detail.object.key });
  }
  return out;
}

exports.handler = async (event, context) => {
  const requestId = context && context.awsRequestId ? context.awsRequestId : undefined;
  const extracted = extractS3Events(event);
  logger.info('email-ingest invoked', { requestId, recordCount: extracted.length, source: event?.source || undefined });
  if (!RESULTS_TABLE) throw new Error('Missing RESULTS_TABLE');
  if (!EXPLORER_API_URL) throw new Error('Missing EXPLORER_API_URL');
  if (!CONTRACT_ADDRESS) throw new Error('Missing CONTRACT_ADDRESS');

  if (extracted.length === 0) {
    logger.warn('No S3 records in event (unexpected)');
    return { ok: true, processed: 0 };
  }

  for (const rec of extracted) {
    try {
      const bucket = rec.bucket;
      const key = decodeURIComponent(String(rec.key).replace(/\+/g, ' '));
      logger.info('Processing S3 object', { bucket, key });

      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const raw = await streamToString(obj.Body);

      // quoted-printable 部分のデコード（雑だがメール全体に適用）
      const text = decodeQuotedPrintable(raw);
      const txHash = extractTxHashFromText(text);
      if (!txHash) {
        logger.warn('TxHash not found in email', { bucket, key });
        // 軽微な未検出（同一Txで複数メールのうちTxIDなしのもの）は SoftMiss として計上
        emitMetric('SoftMiss', 'TxHashNotFound');
        continue;
      }
      logger.info('TxHash extracted', { txHash });

      let receipt;
      try {
        receipt = await fetchReceiptFromExplorer(txHash);
      } catch (e) {
        logger.warn('Explorer API error', { error: e && e.message ? e.message : String(e), txHash });
        emitMetric('Failures', 'ExplorerError');
        continue;
      }
      logger.debug('Explorer receipt fetched');

      const correlationId = extractCorrelationIdFromLogs(receipt);
      if (!correlationId) {
        logger.warn('CorrelationId not found in logs', { txHash });
        emitMetric('SoftMiss', 'CorrelationIdNotFound');
        continue;
      }
      logger.info('CorrelationId extracted', { correlationId });

      try {
        logger.info('Putting item to DynamoDB', { table: RESULTS_TABLE });
        await putResultItem(correlationId, txHash);
        logger.info('DynamoDB write success');
      } catch (e) {
        logger.error('DynamoDB PutItem failed', { error: e && e.message ? e.message : String(e) });
        emitMetric('Failures', 'DdbError');
        continue;
      }
    } catch (e) {
      logger.error('Unexpected processing error', { error: e && e.message ? e.message : String(e) });
      emitMetric('Failures', 'UnexpectedError');
      // 1レコード失敗でも他は処理継続
    }
  }
  logger.info('email-ingest finished');
  return { ok: true };
};


