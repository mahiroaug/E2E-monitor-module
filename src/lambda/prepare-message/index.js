/**
 * prepare-message Lambda（Step Functions内で同期実行）
 *
 * 役割: correlationId と tagSeed を bytes32（Hex32）に変換し、
 *       tx-senderへ渡す SQSメッセージボディ（JSON文字列）を組み立てる。
 * 入力: { correlationId: string, tagSeed?: string }
 * 出力: { correlationIdHex32: string, tagHex32: string, messageBody: string }
 */

const { randomUUID } = require('crypto');

function toBytes32HexFromString(input) {
  const hex = Buffer.from(String(input)).toString('hex');
  const trimmed = hex.length > 64 ? hex.slice(0, 64) : hex;
  const padded = trimmed.padEnd(64, '0');
  return `0x${padded}`;
}

exports.handler = async (event) => {
  const correlationId = event?.correlationId || randomUUID();
  const tagSeed = event?.tagSeed || 'default';

  const correlationIdHex32 = toBytes32HexFromString(correlationId);
  const tagHex32 = toBytes32HexFromString(tagSeed);

  const body = {
    correlationIdHex32,
    tagHex32,
  };

  return {
    correlationIdHex32,
    tagHex32,
    messageBody: JSON.stringify(body),
  };
};


