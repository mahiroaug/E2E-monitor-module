/**
 * prepare-message Lambda（Step Functions内で同期実行）
 *
 * 役割: correlationId と tagSeed を bytes32（Hex32）に変換し、
 *       tx-senderへ渡す SQSメッセージボディ（JSON文字列）を組み立てる。
 * 入力: { correlationId: string, tagSeed?: string }
 * 出力: { correlationIdHex32: string, tagHex32: string, messageBody: string }
 */

const { randomUUID, createHash } = require('crypto');

function toBytes32HexFromString(input) {
  const inputStr = String(input);

  // UUIDは36文字（hexで72文字）なので必ずbytes32（64文字）を超える
  // 一貫性のため、常にSHA256ハッシュ化して32バイトに収める
  const hash = createHash('sha256').update(inputStr).digest('hex');
  return `0x${hash}`;
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


