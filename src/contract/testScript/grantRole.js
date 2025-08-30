/**
 * HOW TO USE
 *
 * 前提:
 * - プロジェクトルートに .env を配置（本スクリプトは .env を自動探索）
 * - 実行アカウントは E2eMonitor の DEFAULT_ADMIN_ROLE（=デプロイヤ）であること
 * - 必須ENV: FIREBLOCKS_SECRET_KEY_FILE, FIREBLOCKS_API_KEY, FIREBLOCKS_VID_DEPLOYER, CA_E2E_MONITOR
 * - 任意ENV: RPC_URL(既定 https://rpc-amoy.polygon.technology), CHAIN_ID(既定 80002)
 *
 * 実行例:
 *   # SENDER_ROLE を Fireblocks送信EOAに付与
 *   node src/contract/testScript/grantRole.js SENDER_ROLE 0xYourSenderAddress
 *
 *   # 任意のロール名を付与（AccessControlベース）
 *   node src/contract/testScript/grantRole.js MY_ROLE 0xTargetAddress
 */

// .env 読み込み（呼び出し場所に依らず）
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

const RPC_URL = process.env.RPC_URL || 'https://rpc-amoy.polygon.technology';
const CHAIN_ID = Number(process.env.CHAIN_ID || 80002);

function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

async function main(roleName, targetAddress) {
  if (!roleName) {
    throw new Error('usage: node grantRole.js <ROLE_NAME> <TARGET_ADDRESS>');
  }
  if (!targetAddress || !ethers.isAddress(targetAddress)) {
    throw new Error('TARGET_ADDRESS is missing or invalid');
  }

  const secretKeyFile = requireEnv('FIREBLOCKS_SECRET_KEY_FILE');
  const fireblocksApiKey = requireEnv('FIREBLOCKS_API_KEY');
  const vaultAccountId = requireEnv('FIREBLOCKS_VID_DEPLOYER');
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

  const provider = new ethers.BrowserProvider(fbProvider);
  const signer = await provider.getSigner();

  const admin = await signer.getAddress();
  console.log('Admin (signer):', admin);
  console.log('Contract       :', contractAddress);
  console.log('Role name      :', roleName);
  console.log('Target         :', targetAddress);

  // AccessControl の role は keccak256(roleName)
  const role = ethers.id(roleName);
  console.log('Role hash      :', role);

  const abi = [
    'function grantRole(bytes32 role, address account) external',
    'function hasRole(bytes32 role, address account) external view returns (bool)'
  ];
  const contract = new ethers.Contract(contractAddress, abi, signer);

  // 既に付与済みか確認
  try {
    const already = await contract.hasRole(role, targetAddress);
    if (already) {
      console.log('Already granted. Nothing to do.');
      return;
    }
  } catch (_) {}

  const tx = await contract.grantRole(role, targetAddress);
  console.log('Tx hash:', tx.hash);
  const rc = await tx.wait();
  console.log('Confirmed in block:', rc.blockNumber);

  // 確認
  try {
    const ok = await contract.hasRole(role, targetAddress);
    console.log('hasRole after grant:', ok);
  } catch (_) {}
}

const args = process.argv.slice(2);
main(args[0], args[1])
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });


