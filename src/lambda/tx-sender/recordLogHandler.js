/**
 * SQSトリガーで起動するLambda関数
 * Fireblocks経由で E2eMonitor コントラクトの ping を発行する
 *
 * 環境変数（ENV）
 * - RPC_URL            : 送信に利用するRPCエンドポイントURL（既定: https://rpc-amoy.polygon.technology）
 * - CHAIN_ID           : チェーンID（数値、既定: 80002）
 * - SSM_PREFIX         : SSMパラメータのプレフィックス（既定: /E2E-module/）
 * - CA_E2E_MONITOR     : コントラクトアドレス（任意。未指定時は SSM `${SSM_PREFIX}contract/e2e_monitor_address` を参照）
 *
 * 参照する SSM パラメータ（SSM_PREFIX をベースに解決）
 * - `${SSM_PREFIX}fireblocks/api_key`
 * - `${SSM_PREFIX}fireblocks/secret_key`
 * - `${SSM_PREFIX}fireblocks/vault_id`
 * - `${SSM_PREFIX}contract/e2e_monitor_address`（ENV 未設定時）
 */
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { FireblocksWeb3Provider } = require('@fireblocks/fireblocks-web3-provider');
const { ethers } = require('ethers');

// 定数定義
const CONSTANTS = {
  RPC_URL: process.env.RPC_URL || 'https://rpc-amoy.polygon.technology',
  CHAIN_ID: Number(process.env.CHAIN_ID || 80002),
  SSM_PREFIX: process.env.SSM_PREFIX || '/E2E-module/',
  ERROR_TYPES: {
    VALIDATION: 'validation',
    TRANSACTION: 'transaction',
    SYSTEM: 'system'
  }
};

// SSMパラメータ名
const SSM_PARAMS = {
  FIREBLOCKS_API_KEY: `${CONSTANTS.SSM_PREFIX}fireblocks/api_key`,
  FIREBLOCKS_API_SECRET: `${CONSTANTS.SSM_PREFIX}fireblocks/secret_key`,
  FIREBLOCKS_VID_PINGER: `${CONSTANTS.SSM_PREFIX}fireblocks/vault_id`,
  E2E_MONITOR_ADDRESS: `${CONSTANTS.SSM_PREFIX}contract/e2e_monitor_address`
};

// E2eMonitor コントラクトの ABI
const E2E_MONITOR_ABI = [
  "event E2ePing(bytes32 indexed correlationId, address indexed sender, uint256 clientTimestamp, uint256 nonce, uint256 blockTimestamp, bytes32 tag)",
  "function ping(bytes32 correlationId, bytes32 tag, uint256 clientTimestamp, uint256 nonce) external"
];

/**
 * AWS SSMからパラメータを取得するクラス
 */
class ParameterStore {
  constructor() {
    this.client = new SSMClient();
    this.cache = {};
  }

  /**
   * SSMからパラメータを取得（キャッシュあり）
   * @param {string} paramName - パラメータ名
   * @param {boolean} withDecryption - 復号化するかどうか
   * @returns {Promise<string>} - パラメータ値
   */
  async getParameter(paramName, withDecryption = true) {
    // キャッシュにあればそれを返す
    if (this.cache[paramName]) {
      return this.cache[paramName];
    }

    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: withDecryption
    });

    const response = await this.client.send(command);
    const value = response.Parameter.Value;

    // キャッシュに保存
    this.cache[paramName] = value;

    return value;
  }

  /**
   * 必要なすべてのパラメータを一度に取得
   * @returns {Promise<Object>} - パラメータのオブジェクト
   */
  async getAllParameters() {
    const [apiKey, apiSecret, vaultAccountId] = await Promise.all([
      this.getParameter(SSM_PARAMS.FIREBLOCKS_API_KEY),
      this.getParameter(SSM_PARAMS.FIREBLOCKS_API_SECRET),
      this.getParameter(SSM_PARAMS.FIREBLOCKS_VID_PINGER)
    ]);

    // コントラクトアドレスは環境変数優先、なければ SSM
    let contractAddress = process.env.CA_E2E_MONITOR;
    if (!contractAddress) {
      try {
        contractAddress = await this.getParameter(SSM_PARAMS.E2E_MONITOR_ADDRESS, false);
      } catch (e) {
        // noop
      }
    }

    return { apiKey, apiSecret, vaultAccountId, contractAddress };
  }
}

/**
 * ブロックチェーントランザクションを処理するクラス
 */
class BlockchainService {
  /**
   * @param {Object} params - 初期化パラメータ
   * @param {string} params.apiKey - Fireblocks API Key
   * @param {string} params.apiSecret - Fireblocks API Secret
   * @param {string} params.vaultAccountId - Fireblocks Vault ID
   * @param {string} params.contractAddress - コントラクトアドレス
   */
  constructor(params) {
    this.apiKey = params.apiKey;
    this.apiSecret = params.apiSecret;
    this.vaultAccountId = params.vaultAccountId;
    this.contractAddress = params.contractAddress;
    this.provider = null;
    this.signer = null;
    this.contract = null;
  }

  /**
   * ブロックチェーンとの接続を初期化
   * @returns {Promise<void>}
   */
  async initialize() {
    console.log('Initializing blockchain connection');

    // 必須パラメータ検証
    if (!this.apiKey || !this.apiSecret || !this.vaultAccountId) {
      throw new Error('Missing Fireblocks credentials (apiKey/apiSecret/vaultAccountId)');
    }
    if (!this.contractAddress) {
      throw new Error('Missing contract address (CA_E2E_MONITOR or SSM)');
    }
    if (!ethers.isAddress(this.contractAddress)) {
      throw new Error(`Invalid contract address: ${this.contractAddress}`);
    }

    console.log('Fireblocks VaultID:', this.vaultAccountId);
    console.log('E2eMonitor Contract:', this.contractAddress);

    // Fireblocks Web3 Providerの設定
    const fireblocksProvider = new FireblocksWeb3Provider({
      privateKey: this.apiSecret,
      apiKey: this.apiKey,
      vaultAccountIds: this.vaultAccountId,
      chainId: CONSTANTS.CHAIN_ID,
      rpcUrl: CONSTANTS.RPC_URL,
      logTransactionStatusChanges: true,
    });

    // ethers.jsとの連携
    this.provider = new ethers.BrowserProvider(fireblocksProvider);
    // 接続性・チェーンIDの整合性チェック
    try {
      const chainIdHex = await this.provider.send('eth_chainId', []);
      const chainId = typeof chainIdHex === 'string' ? parseInt(chainIdHex, 16) : Number(chainIdHex);
      if (Number.isFinite(chainId)) {
        console.log('Connected chainId:', chainId);
        if (chainId !== CONSTANTS.CHAIN_ID) {
          console.warn(`ChainId mismatch. expected=${CONSTANTS.CHAIN_ID}, actual=${chainId}`);
        }
      }
    } catch (e) {
      console.warn('Could not verify chain id via eth_chainId:', e && e.message ? e.message : String(e));
    }

    this.signer = await this.provider.getSigner();

    // コントラクトインスタンスを作成
    this.contract = new ethers.Contract(this.contractAddress, E2E_MONITOR_ABI, this.signer);
  }

  /**
   * E2eMonitor.ping を送信
   * @param {Object} params - 送信パラメータ
   * @param {string} params.correlationIdHex32 - 0x + 64桁の bytes32
   * @param {string} params.tagHex32 - 0x + 64桁の bytes32
   * @returns {Promise<Object>} - トランザクション結果
   */
  async sendPing(params) {
    const { correlationIdHex32, tagHex32 } = params;

    console.log(JSON.stringify({ message: 'Sending E2eMonitor.ping', correlationIdHex32, tagHex32 }, null, 2));

    try {
      const senderAddress = await this.signer.getAddress();
      const nonce = await this.provider.getTransactionCount(senderAddress);
      const clientTimestamp = Math.floor(Date.now() / 1000);

      // トランザクションを送信
      const tx = await this.contract.ping(correlationIdHex32, tagHex32, clientTimestamp, nonce);
      console.log('Transaction hash:', tx.hash);

      // トランザクション完了を待機
      const receipt = await tx.wait();
      console.log('Transaction completed! Block number:', receipt.blockNumber);

      return {
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber
      };
    } catch (err) {
      // ethers v6 エラー整形
      const message = (err && err.shortMessage) || (err && err.message) || String(err);
      throw new Error(message);
    }
  }
}

/**
 * メッセージ検証ユーティリティ
 */
class MessageValidator {
  /**
   * 入力パラメータのバリデーション（E2eMonitor.ping 用）
   * @param {Object} messageBody - メッセージボディ（JSON）
   * @returns {Object} - 検証結果とパラメータ
   *   success: boolean - 検証成功の場合true
   *   error: string - エラーメッセージ（成功時はnull）
   *   params: Object - 型変換・正規化済みのパラメータ（成功時のみ）
   */
  static validateMessage(messageBody) {
    try {
      if (typeof messageBody !== 'object' || messageBody === null) {
        return { success: false, error: 'Message body must be a JSON object' };
      }

      const correlationIdHex32 = typeof messageBody.correlationIdHex32 === 'string' ? messageBody.correlationIdHex32 : '';
      const tagHex32 = typeof messageBody.tagHex32 === 'string' ? messageBody.tagHex32 : '';

      if (!correlationIdHex32 || !/^0x[0-9a-fA-F]{64}$/.test(correlationIdHex32)) {
        return { success: false, error: 'Invalid correlationIdHex32 (must be 0x + 64 hex chars)' };
      }
      if (!tagHex32 || !/^0x[0-9a-fA-F]{64}$/.test(tagHex32)) {
        return { success: false, error: 'Invalid tagHex32 (must be 0x + 64 hex chars)' };
      }

      return {
        success: true,
        error: null,
        params: { correlationIdHex32, tagHex32 }
      };
    } catch (error) {
      return {
        success: false,
        error: `Validation error: ${error.message}`
      };
    }
  }

  /**
   * エラータイプを判定する
   * @param {string} errorMessage - エラーメッセージ
   * @returns {string} - エラータイプ
   */
  static determineErrorType(errorMessage) {
    // Fireblocksやブロックチェーン関連のエラーパターン
    const transactionErrorPatterns = [
      'nonce',
      'gas',
      'underpriced',
      'timeout',
      'rejected',
      'reverted',
      'dropped',
      'fireblocks',
      'network',
      'connection',
      'rpc',
      'rate limit',
      'exceeded'
    ];

    // トランザクションエラーかどうかを判定
    const isTransactionError = transactionErrorPatterns.some(pattern =>
      errorMessage.toLowerCase().includes(pattern.toLowerCase())
    );

    // エラータイプを判定
    if (errorMessage.startsWith('Validation error:') ||
      errorMessage.includes('required parameter:') ||
      errorMessage.includes('must be an') ||
      errorMessage.includes('Invalid hash length')) {
      return CONSTANTS.ERROR_TYPES.VALIDATION;
    } else if (isTransactionError) {
      return CONSTANTS.ERROR_TYPES.TRANSACTION;
    } else {
      return CONSTANTS.ERROR_TYPES.SYSTEM;
    }
  }

  /**
   * エラータイプに基づいて再処理が必要かどうかを判定
   * @param {string} errorType - エラータイプ
   * @returns {boolean} - 再処理が必要な場合true
   */
  static shouldRetry(errorType) {
    // トランザクションエラーとシステムエラーは再処理
    return errorType === CONSTANTS.ERROR_TYPES.TRANSACTION ||
      errorType === CONSTANTS.ERROR_TYPES.SYSTEM;
    // バリデーションエラーは再処理しない
  }
}

/**
 * メッセージ処理の結果を追跡するクラス
 */
class ProcessingTracker {
  constructor(totalMessages) {
    this.processedMessageIds = new Set();
    this.batchItemFailures = [];
    this.results = [];
    this.stats = {
      total: totalMessages,
      success: 0,
      validationErrors: 0,
      transactionErrors: 0,
      systemErrors: 0
    };
  }

  /**
   * 処理成功を記録
   * @param {string} messageId - メッセージID
   * @param {Object} txResult - トランザクション結果
   */
  recordSuccess(messageId, txResult) {
    this.stats.success++;

    this.results.push({
      messageId,
      status: 'success',
      transactionHash: txResult.transactionHash,
      blockNumber: txResult.blockNumber
    });

    // 成功したメッセージは処理完了としてマーク（再処理しない）
    this.processedMessageIds.add(messageId);
  }

  /**
   * エラーを記録
   * @param {string} messageId - メッセージID
   * @param {string} errorMessage - エラーメッセージ
   * @param {string} prefix - エラーメッセージのプレフィックス（オプション）
   */
  recordError(messageId, errorMessage, prefix = '') {
    const fullErrorMessage = prefix ? `${prefix}: ${errorMessage}` : errorMessage;
    const errorType = MessageValidator.determineErrorType(fullErrorMessage);
    const willRetry = MessageValidator.shouldRetry(errorType);

    // エラータイプごとのカウントを更新
    if (errorType === CONSTANTS.ERROR_TYPES.VALIDATION) {
      this.stats.validationErrors++;
      // バリデーションエラーは処理済みとマーク（再処理しない）
      this.processedMessageIds.add(messageId);
    } else if (errorType === CONSTANTS.ERROR_TYPES.TRANSACTION) {
      this.stats.transactionErrors++;
    } else {
      this.stats.systemErrors++;
    }

    this.results.push({
      messageId,
      status: 'error',
      errorType,
      error: fullErrorMessage,
      willRetry
    });

    // 再処理が必要なエラーの場合のみ失敗リストに追加
    if (willRetry) {
      this.batchItemFailures.push({
        itemIdentifier: messageId
      });
    }
  }

  /**
   * 処理統計とログを出力
   */
  logResults() {
    console.log('Processing stats:', this.stats);
    console.log('Processed message IDs (will not be retried):', Array.from(this.processedMessageIds));
    console.log('Failed messages that will be retried:', this.batchItemFailures.length);
  }

  /**
   * Lambda関数の戻り値を生成
   * @returns {Object} - SQSバッチ応答形式のレスポンス
   */
  generateResponse() {
    return {
      batchItemFailures: this.batchItemFailures,
      processingResults: {
        stats: this.stats,
        details: this.results
      }
    };
  }

  /**
   * 全体エラー時のレスポンスを生成
   * @param {string} errorMessage - エラーメッセージ
   * @param {Array} allMessageIds - すべてのメッセージID配列
   * @returns {Object} - SQSバッチ応答形式のレスポンス
   */
  generateErrorResponse(errorMessage, allMessageIds) {
    const errorType = MessageValidator.determineErrorType(errorMessage);
    let batchItemFailures = [];

    // バリデーションエラー以外の場合、未処理のメッセージのみを再処理
    if (MessageValidator.shouldRetry(errorType)) {
      batchItemFailures = allMessageIds
        .filter(messageId => !this.processedMessageIds.has(messageId))
        .map(messageId => ({
          itemIdentifier: messageId
        }));
    }

    console.log('Global error type:', errorType);
    console.log('Global error - messages to be retried:', batchItemFailures.length);

    return {
      batchItemFailures,
      error: errorMessage,
      errorType
    };
  }
}

/**
 * Lambda関数のメインハンドラー
 */
exports.handler = async (event) => {
  // 処理追跡インスタンスを作成
  const tracker = new ProcessingTracker((event.Records || []).length);

  try {
    console.log('SQS event received:', JSON.stringify(event));

    // SQSメッセージを解析
    const sqsMessages = event.Records || [];
    if (sqsMessages.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'No messages found' })
      };
    }

    // SSMから設定パラメータを取得
    const paramStore = new ParameterStore();
    const params = await paramStore.getAllParameters();

    // ブロックチェーンサービスを初期化
    const blockchainService = new BlockchainService(params);
    await blockchainService.initialize();

    // 各メッセージを処理
    for (const message of sqsMessages) {
      try {
        // メッセージボディをJSONとしてパース
        const messageBody = JSON.parse(message.body);
        console.log('Message body:', messageBody);

        // パラメータのバリデーション
        const validation = MessageValidator.validateMessage(messageBody);
        if (!validation.success) {
          console.error('Validation error:', validation.error, messageBody);
          tracker.recordError(message.messageId, validation.error, 'Validation error');
          continue;
        }

        try {
          // E2eMonitor.ping を送信
          const txResult = await blockchainService.sendPing(validation.params);
          tracker.recordSuccess(message.messageId, txResult);
        } catch (txError) {
          console.error('Transaction execution error:', txError);
          tracker.recordError(message.messageId, txError.message, 'Transaction error');
        }
      } catch (messageError) {
        // メッセージ処理中の予期せぬエラー
        console.error('Message processing error:', messageError.message, 'MessageId:', message.messageId);
        tracker.recordError(message.messageId, messageError.message, 'Message processing error');
      }
    }

    // 処理結果をログ出力
    tracker.logResults();

    // SQSバッチ応答形式で結果を返す
    return tracker.generateResponse();

  } catch (globalError) {
    // Lambda関数全体での予期せぬエラー
    console.error('Lambda function execution error:', globalError);

    // 全メッセージIDを抽出
    const allMessageIds = (event.Records || []).map(record => record.messageId);

    // エラーレスポンスを生成
    return tracker.generateErrorResponse(globalError.message, allMessageIds);
  }
};
