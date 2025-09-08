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
const RPC_ALCHEMY_URL = process.env.RPC_ALCHEMY_URL || '';
const RPC_ALCHEMY_APIKEY = process.env.RPC_ALCHEMY_APIKEY || '';
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
  // 2) ラベル付き（多言語対応）
  const labelPatterns = [
    /TxID\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /Tx\s*Id\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /TxHash\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /Tx\s*Hash\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /Transaction\s*Hash\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /トランザクションID\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /トランザクションハッシュ\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
    /取引ID\s*[:：]\s*(0x[a-fA-F0-9]{64})/i,
  ];
  for (const re of labelPatterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  // 裸の64桁ハッシュは誤検知（EventID等）が多いため採用しない
  return null;
}

function classifyEmail(text, rawEmail) {
  const txHash = extractTxHashFromText(text);
  if (txHash) return { type: 'event', txHash };
  if (isBalanceMail(text, rawEmail)) return { type: 'balance' };
  return { type: 'other' };
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
  logger.info('Explorer (Polygonscan-compatible) receipt fetch success', { txhash: txHash });
  return body.result;
}

// Alchemy JSON-RPC 経由
async function fetchReceiptViaAlchemy(txHash) {
  if (!RPC_ALCHEMY_URL) throw new Error('Alchemy URL not configured');
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  };
  // エンドポイント解決: すでに /v2/<key> を含むならそのまま。/v2 で終わるなら /<key> を付与。
  // それ以外は末尾に /v2/<key> を付与（APIKEYが無ければURLそのまま）。
  let endpoint = RPC_ALCHEMY_URL.trim();
  if (endpoint.includes('/v2/')) {
    // 完全URL（キー含む）
  } else if (endpoint.endsWith('/v2') && RPC_ALCHEMY_APIKEY) {
    endpoint = `${endpoint}/${RPC_ALCHEMY_APIKEY}`;
  } else if (RPC_ALCHEMY_APIKEY) {
    endpoint = endpoint.replace(/\/+$/, '') + `/v2/${RPC_ALCHEMY_APIKEY}`;
  }
  logger.debug('Alchemy RPC request', { endpoint, method: body.method, txhash: txHash });
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Alchemy RPC error: ${res.status}`);
  const json = await res.json();
  if (!json || !json.result) throw new Error('Invalid alchemy response');
  logger.info('Alchemy RPC receipt fetch success', { txhash: txHash });
  return json.result;
}

async function fetchReceipt(txHash) {
  if (RPC_ALCHEMY_URL) {
    try {
      logger.info('Receipt fetch route selected', { route: 'alchemy' });
      return await fetchReceiptViaAlchemy(txHash);
    } catch (e) {
      logger.warn('Alchemy RPC failed, fallback to explorer', {
        error: e && e.message ? e.message : String(e),
        fallbackRoute: 'alchemy->explorer',
      });
    }
  }
  logger.info('Receipt fetch route selected', { route: 'explorer' });
  return await fetchReceiptFromExplorer(txHash);
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

// バランス通知のハートビートを記録
async function putBalanceHeartbeat() {
  const now = new Date().toISOString();
  const item = {
    correlationId: 'HB#BALANCE',
    type: 'BALANCE_HEARTBEAT',
    lastSeen: now,
  };
  await ddb.send(new PutCommand({ TableName: RESULTS_TABLE, Item: item }));
}

function decodeRfc2047(str) {
  return String(str || '')
    .replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, b64) => {
      try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return _; }
    })
    .replace(/=\?utf-8\?q\?([^?]+)\?=/gi, (_, q) => {
      try {
        const replaced = q.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        return replaced;
      } catch {
        return _;
      }
    });
}

function extractSubject(rawEmail) {
  const raw = String(rawEmail || '');
  const headerEndIdx = raw.indexOf('\n\n');
  const headers = headerEndIdx >= 0 ? raw.slice(0, headerEndIdx) : raw;
  const lines = headers.split(/\r?\n/);
  let subject = '';
  let capturing = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!capturing) {
      const m = /^Subject:\s*(.*)$/i.exec(line);
      if (m) {
        subject = m[1];
        capturing = true;
      }
    } else {
      if (/^[\t\s]/.test(line)) subject += ' ' + line.trim();
      else break;
    }
  }
  return decodeRfc2047(subject).trim();
}

function isBalanceMail(text, rawEmail) {
  // 件名優先
  const subj = extractSubject(rawEmail).toLowerCase();
  if (subj) {
    if (subj.includes('wallet') && subj.includes('balance')) return true;
    if (subj.includes('ウォレット残高')) return true;
    if (/ウォレット\s*.*\s*残高/.test(subj) || /残高\s*.*\s*ウォレット/.test(subj) || subj.includes('残高通知')) return true;
  }
  // 本文
  const decoded = decodeRfc2047(String(text || ''));
  const lower = decoded.toLowerCase();
  const normalized = lower.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (normalized.includes('wallet') && normalized.includes('balance')) return true;
  if (normalized.includes('ウォレット残高')) return true;
  const jpPatterns = [/ウォレット\s*.*\s*残高/, /残高\s*.*\s*ウォレット/, /残高通知/];
  for (const re of jpPatterns) if (re.test(normalized)) return true;
  return false;
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

      // 種類判別 → 種類別処理
      const classification = classifyEmail(text, raw);
      logger.info('Email classified', { type: classification.type });

      if (classification.type === 'balance') {
        logger.info('Balance notification email detected, recording heartbeat');
        try {
          await putBalanceHeartbeat();
          logger.info('Balance heartbeat recorded');
        } catch (e) {
          logger.warn('Balance heartbeat write failed', { error: e && e.message ? e.message : String(e) });
        }
        continue; // balance はここで完了
      }

      if (classification.type === 'other') {
        logger.info('Other mail type detected, skipping');
        continue;
      }

      const txHash = classification.txHash;
      logger.info('TxHash extracted', { txHash });

      let receipt;
      try {
        receipt = await fetchReceipt(txHash);
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


