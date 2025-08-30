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

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// CloudWatch Embedded Metric Format (EMF) で失敗メトリクスを出力
function emitFailureMetric(reason) {
  try {
    const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'email-ingest';
    const metricPayload = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'E2E/EmailIngest',
            Dimensions: [['FunctionName']],
            Metrics: [{ Name: 'Failures', Unit: 'Count' }],
          },
          {
            Namespace: 'E2E/EmailIngest',
            Dimensions: [['FunctionName', 'Reason']],
            Metrics: [{ Name: 'Failures', Unit: 'Count' }],
          },
        ],
      },
      FunctionName: functionName,
      Reason: reason,
      Failures: 1,
    };
    console.log(JSON.stringify(metricPayload));
  } catch (e) {
    // メトリクス出力失敗時も処理は継続
    console.warn('emitFailureMetric error:', e && e.message ? e.message : String(e));
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
  // 1) 直接 0x64桁
  const direct = text.match(/0x[a-fA-F0-9]{64}/);
  if (direct) return direct[0];
  // 2) エクスプローラURLの末尾
  const url = text.match(/https?:\/\/\S*?\/tx\/0x[a-fA-F0-9]{64}/);
  if (url) {
    const m = url[0].match(/0x[a-fA-F0-9]{64}/);
    if (m) return m[0];
  }
  return null;
}

async function fetchReceiptFromExplorer(txHash) {
  const url = new URL(EXPLORER_API_URL);
  // Polygonscan 互換の proxy API
  url.searchParams.set('module', 'proxy');
  url.searchParams.set('action', 'eth_getTransactionReceipt');
  url.searchParams.set('txhash', txHash);
  if (EXPLORER_API_KEY) url.searchParams.set('apikey', EXPLORER_API_KEY);

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

exports.handler = async (event) => {
  if (!RESULTS_TABLE) throw new Error('Missing RESULTS_TABLE');
  if (!EXPLORER_API_URL) throw new Error('Missing EXPLORER_API_URL');
  if (!CONTRACT_ADDRESS) throw new Error('Missing CONTRACT_ADDRESS');

  const records = event.Records || [];
  for (const r of records) {
    try {
      const bucket = r.s3.bucket.name;
      const key = decodeURIComponent(r.s3.object.key.replace(/\+/g, ' '));

      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const raw = await streamToString(obj.Body);

      // quoted-printable 部分のデコード（雑だがメール全体に適用）
      const text = decodeQuotedPrintable(raw);
      const txHash = extractTxHashFromText(text);
      if (!txHash) {
        console.warn('TxHash not found in email:', { bucket, key });
        emitFailureMetric('TxHashNotFound');
        continue;
      }

      let receipt;
      try {
        receipt = await fetchReceiptFromExplorer(txHash);
      } catch (e) {
        console.warn('Explorer API error:', e && e.message ? e.message : String(e));
        emitFailureMetric('ExplorerError');
        continue;
      }

      const correlationId = extractCorrelationIdFromLogs(receipt);
      if (!correlationId) {
        console.warn('CorrelationId not found in logs:', { txHash });
        emitFailureMetric('CorrelationIdNotFound');
        continue;
      }

      await putResultItem(correlationId, txHash);
    } catch (e) {
      console.warn('Unexpected processing error:', e && e.message ? e.message : String(e));
      emitFailureMetric('UnexpectedError');
      // 1レコード失敗でも他は処理継続
    }
  }

  return { ok: true };
};


