/**
 * tx-sender Lambda
 *
 * 役割: SQSメッセージ（bytes32のcorrelationIdHex32/tagHex32）を受け取り、
 *       Fireblocks経由で E2eMonitor.ping を送信するエントリーポイント。
 * トリガー: SQS `e2emm-main-queue-<stage>`
 * 入力: messageBody(JSON) { correlationIdHex32, tagHex32 }
 */
const { handler: recordLogHandler } = require('./recordLogHandler');

exports.handler = async (event, context) => {
  return await recordLogHandler(event, context);
};


