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
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

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

function makeEventBucket(epochMs) {
  const d = new Date(epochMs);
  // yyyyMMddHHmm（1分バケット）
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

async function upsertEventRecord(correlationId, txHash, eventEmailAtMs) {
  try {
    // まず既存レコードを取得
    const existing = await ddb.send(new GetCommand({
      TableName: RESULTS_TABLE,
      Key: { correlationId },
    }));

    // レコードが存在しない場合（通常はStep Functionsが先に作成するためあり得ない）
    if (!existing.Item) {
      logger.warn('No existing record found for correlationId (unexpected)', {
        correlationId,
        txHash,
      });
      emitMetric('SoftMiss', 'EventRecordNotFound');
      return; // レコードが存在しないため処理スキップ
    }

    // 既にcorrelationResolved=trueの場合は重複
    if (existing.Item.correlationResolved === true) {
      logger.info('Event already processed (duplicate event notification)', {
        correlationId,
        existingTxHash: existing.Item.txHash,
        newTxHash: txHash,
      });

      // メトリクス: イベント通知の重複
      emitMetric('SoftMiss', 'EventDuplicate');

      // txHashが異なる場合は警告
      if (existing.Item.txHash !== txHash) {
        logger.warn('Duplicate event with different txHash', {
          correlationId,
          existingTxHash: existing.Item.txHash,
          newTxHash: txHash,
        });
      }

      return; // 更新しない
    }

    // 新規または未処理の場合のみ更新
    const newStatus = existing.Item?.balanceReceived === true
      ? 'SUCCESS'      // 既に残高受信済み（順序逆転ケース）
      : 'EVENT_ONLY';  // 残高待ち

    const eventFields = makeTimestampFields(eventEmailAtMs, 'eventEmailAt');
    const updatedFields = makeTimestampFields(Date.now(), 'updatedAt');

    await ddb.send(new UpdateCommand({
      TableName: RESULTS_TABLE,
      Key: { correlationId },
      UpdateExpression: `
        SET txHash = :txHash,
            correlationResolved = :true,
            eventEmailAtMs = :eventMs,
            eventEmailAt = :eventUtc,
            eventEmailAtJST = :eventJst,
            eventBucket = :eventBucket,
            #status = :status,
            updatedAtMs = :updMs,
            updatedAt = :updUtc,
            updatedAtJST = :updJst
      `,
      // ★ correlationResolvedがfalseまたは存在しない場合のみ更新
      ConditionExpression: `
        (correlationResolved = :false OR attribute_not_exists(correlationResolved))
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':txHash': txHash,
        ':true': true,
        ':false': false,
        ':eventMs': eventFields.eventEmailAtMs,
        ':eventUtc': eventFields.eventEmailAt,
        ':eventJst': eventFields.eventEmailAtJST,
        ':eventBucket': makeEventBucket(eventEmailAtMs),
        ':status': newStatus,
        ':updMs': updatedFields.updatedAtMs,
        ':updUtc': updatedFields.updatedAt,
        ':updJst': updatedFields.updatedAtJST,
      },
    }));

    logger.info('Event record updated', { correlationId, status: newStatus });

  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      logger.info('Event already processed (race condition)', { correlationId });
      emitMetric('SoftMiss', 'EventRaceCondition');
      return;
    }
    throw e;
  }
}

// バランス通知: 時間相関で最も近いイベント実行レコードに紐付け
async function attachBalanceByTimeWindow() {
  const nowMs = Date.now();
  const WINDOW_MINUTES = 10; // 10分窓（環境変数化推奨）
  const earliestMs = nowMs - WINDOW_MINUTES * 60 * 1000;

  logger.info('Balance time window', {
    windowMinutes: WINDOW_MINUTES,
    earliestJST: makeTimestampFields(earliestMs, 'earliest').earliestJST,
    nowJST: makeTimestampFields(nowMs, 'now').nowJST,
  });

  // GSI_TimeOrderで最新のレコードを検索
  let result;
  try {
    result = await ddb.send(new QueryCommand({
      TableName: RESULTS_TABLE,
      IndexName: 'GSI_TimeOrder',
      KeyConditionExpression: 'recordType = :type AND createdAtMs BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':type': 'E2E_TASK',
        ':start': earliestMs,
        ':end': nowMs,
      },
      ScanIndexForward: false,  // 新しい順
      Limit: 20,
    }));
  } catch (e) {
    logger.error('GSI_TimeOrder query failed', {
      error: e && e.message ? e.message : String(e)
    });
    emitMetric('Failures', 'GsiQueryError');
    return false;
  }

  const candidates = (result.Items || [])
    .filter(item =>
      item.correlationResolved === true &&   // イベント通知済み
      item.balanceReceived !== true          // 残高未受信
    );

  if (candidates.length === 0) {
    logger.info('No eligible record for balance (all already processed or no event yet)');
    // メトリクス: バランス通知の空振り（SoftMiss）
    emitMetric('SoftMiss', 'BalanceNoCandidate');
    return false;
  }

  const balanceFields = makeTimestampFields(nowMs, 'balanceEmailAt');
  const updatedFields = makeTimestampFields(nowMs, 'updatedAt');

  for (const cand of candidates) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: RESULTS_TABLE,
        Key: { correlationId: cand.correlationId },
        UpdateExpression: `
          SET balanceReceived = :true,
              balanceEmailAtMs = :balMs,
              balanceEmailAt = :balUtc,
              balanceEmailAtJST = :balJst,
              #status = :success,
              updatedAtMs = :updMs,
              updatedAt = :updUtc,
              updatedAtJST = :updJst
        `,
        // ★ 重要: balanceReceivedがfalseまたは存在しない場合のみ更新
        ConditionExpression: `
          (balanceReceived = :false OR attribute_not_exists(balanceReceived))
        `,
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':true': true,
          ':false': false,
          ':balMs': balanceFields.balanceEmailAtMs,
          ':balUtc': balanceFields.balanceEmailAt,
          ':balJst': balanceFields.balanceEmailAtJST,
          ':success': 'SUCCESS',
          ':updMs': updatedFields.updatedAtMs,
          ':updUtc': updatedFields.updatedAt,
          ':updJst': updatedFields.updatedAtJST,
        },
      }));

      logger.info('Balance attached successfully', {
        correlationId: cand.correlationId,
        createdAtJST: cand.createdAtJST,
      });
      return true;

    } catch (e) {
      // ConditionalCheckFailedException = 既に他の残高通知で処理済み
      if (e.name === 'ConditionalCheckFailedException') {
        logger.debug('Balance attach skipped (already processed)', {
          correlationId: cand.correlationId
        });
        continue; // 次候補へ
      }

      // その他のエラー
      logger.warn('Balance attach failed', {
        correlationId: cand.correlationId,
        error: e && e.message ? e.message : String(e),
      });
      continue;
    }
  }

  // 全候補が既に処理済み（2通目以降の残高通知）
  logger.info('All candidates already have balance (duplicate balance notification)');
  emitMetric('SoftMiss', 'BalanceDuplicate');
  return false;
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
        logger.info('Balance notification email detected, trying time-window attach');
        try {
          await attachBalanceByTimeWindow();
          logger.info('Balance processed');
        } catch (e) {
          logger.warn('Balance processing failed', { error: e && e.message ? e.message : String(e) });
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
        const nowMs = Date.now();
        logger.info('Upserting event record to DynamoDB', { table: RESULTS_TABLE });
        await upsertEventRecord(correlationId, txHash, nowMs);
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


