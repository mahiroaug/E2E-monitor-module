/**
 * HOW TO USE
 *
 * 前提:
 * - プロジェクトルートに .env を配置（本スクリプトは ../../../.env を読み込み）
 * - 必須ENV: FIREBLOCKS_SECRET_KEY_FILE, FIREBLOCKS_API_KEY, FIREBLOCKS_VID_PINGER, CA_E2E_MONITOR
 * - 任意ENV: RPC_URL(既定 https://rpc-amoy.polygon.technology), CHAIN_ID(既定 80002)
 *
 * 実行例:
 *   # 相関ID/タグを自動生成して送信
 *   node src/contract/testScript/e2eping.js
 *
 *   # 相関ID/タグ(bytes32: 0x + 64 hex) を指定して送信
 *   node src/contract/testScript/e2eping.js 0xaaaaaaaa...64桁 0xbbbbbbbb...64桁
 *
 * 動作:
 * - Fireblocks Provider + ethers を用いて E2eMonitor.ping(correlationId, tag, clientTimestamp, nonce) を送信
 * - TxHash/Receipt(ブロック番号) を表示し、同一ブロック内で E2ePing があれば簡易検出
 *
 * 注意:
 * - correlationId/tag は bytes32（0x+64桁）必須。未指定時はランダム生成
 * - FIREBLOCKS_SECRET_KEY_FILE は .env からの相対/絶対パスを許容
 */
// 環境変数を .env から読み込む（呼び出し場所に依らず解決）
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
(() => {
  const candidates = [
    process.env.DOTENV_PATH,
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '.env'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      break;
    }
  }
})();

const { ethers } = require('ethers');
const { FireblocksWeb3Provider } = require('@fireblocks/fireblocks-web3-provider');

// 定数設定（Polygon Amoy）
const RPC_URL = process.env.RPC_URL || 'https://rpc-amoy.polygon.technology';
const CHAIN_ID = Number(process.env.CHAIN_ID || 80002);

// 必須環境変数の検証と読み込み
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function ensure0x64Hex(hex) {
  if (!hex.startsWith('0x')) hex = '0x' + hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Invalid bytes32 hex: ${hex}`);
  }
  return hex;
}

function randomHex32() {
  return '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
}

// E2eMonitor の ABI（ping とイベントのみ）
const E2E_MONITOR_ABI = [
  'event E2ePing(bytes32 indexed correlationId, address indexed sender, uint256 clientTimestamp, uint256 nonce, uint256 blockTimestamp, bytes32 tag)',
  'function ping(bytes32 correlationId, bytes32 tag, uint256 clientTimestamp, uint256 nonce) external'
];

async function main(argCorrelationIdHex32, argTagHex32) {
  // 環境変数読み込み
  const secretKeyFile = requireEnv('FIREBLOCKS_SECRET_KEY_FILE');
  const fireblocksApiKey = requireEnv('FIREBLOCKS_API_KEY');
  const vaultAccountId = requireEnv('FIREBLOCKS_VID_PINGER');
  const contractAddress = requireEnv('CA_E2E_MONITOR');

  const privateKeyContent = fs.readFileSync(path.resolve(__dirname, '../../../', secretKeyFile), 'utf8');

  // Fireblocks Provider 構築
  const fbProvider = new FireblocksWeb3Provider({
    privateKey: privateKeyContent,
    apiKey: fireblocksApiKey,
    vaultAccountIds: vaultAccountId,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    logTransactionStatusChanges: true,
  });

  // ethers v6 連携
  const provider = new ethers.BrowserProvider(fbProvider);
  const signer = await provider.getSigner();

  // パラメータ構築
  const correlationIdHex32 = argCorrelationIdHex32
    ? ensure0x64Hex(argCorrelationIdHex32)
    : randomHex32();
  const tagHex32 = argTagHex32
    ? ensure0x64Hex(argTagHex32)
    : randomHex32();

  const senderAddress = await signer.getAddress();
  const nonce = await provider.getTransactionCount(senderAddress);
  const clientTimestamp = Math.floor(Date.now() / 1000);

  console.log('E2eMonitor ping parameters:');
  console.log('- correlationIdHex32:', correlationIdHex32);
  console.log('- tagHex32         :', tagHex32);
  console.log('- clientTimestamp  :', clientTimestamp);
  console.log('- nonce            :', nonce);
  console.log('Network/Account:');
  try {
    const chainIdHex = await provider.send('eth_chainId', []);
    const chainId = typeof chainIdHex === 'string' ? parseInt(chainIdHex, 16) : Number(chainIdHex);
    console.log('- chainId          :', chainId);
  } catch (e) {
    console.log('- chainId          : [unavailable]', e && e.message ? e.message : String(e));
  }
  console.log('- senderAddress    :', senderAddress);
  console.log('- contractAddress  :', contractAddress);

  // コントラクトインスタンス作成
  const contract = new ethers.Contract(contractAddress, E2E_MONITOR_ABI, signer);

  // トランザクション送信
  const tx = await contract.ping(correlationIdHex32, tagHex32, clientTimestamp, nonce);
  console.log('Transaction hash:', tx.hash);
  const receipt = await tx.wait();
  console.log('Transaction completed. Block number:', receipt.blockNumber);

  // イベントの簡易確認（該当ブロック内でのフィルタ）
  try {
    const events = await contract.queryFilter(contract.filters.E2ePing(correlationIdHex32, null), receipt.blockNumber, receipt.blockNumber);
    if (events && events.length > 0) {
      const ev = events[0];
      console.log('E2ePing detected at tx:', ev.transactionHash);
    } else {
      console.log('E2ePing not found in the same block (this may be normal depending on indexer latency).');
    }
  } catch (e) {
    console.log('Event query skipped:', e && e.message ? e.message : String(e));
  }
}

// CLI 引数: [correlationIdHex32] [tagHex32]
const args = process.argv.slice(2);
const argCorrelationId = args[0];
const argTag = args[1];

main(argCorrelationId, argTag)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });


