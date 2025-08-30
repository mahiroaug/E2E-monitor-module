/**
 * SSM Parameters Stack
 *
 * このスタックは .env（dotenv）から読み込まれた環境変数を既定値として
 * CloudFormation パラメータにマップし、SSM パラメータストアへ登録します。
 *
 * 読み込まれる主な環境変数（.env／環境変数）
 * - FIREBLOCKS_API_KEY       : Fireblocks API Key（機微情報）
 * - FIREBLOCKS_API_SECRET    : Fireblocks API Secret（秘密鍵本文／機微情報）
 * - FIREBLOCKS_VID_DEPLOYER  : Fireblocks Vault Account ID
 * - CA_E2E_MONITOR           : E2eMonitor コントラクトアドレス（0x...）
 * - EXPLORER_API_KEY         : エクスプローラ API Key（Polygonscan 等／機微情報）
 * 備考:
 * - app.ts 側で dotenv をロードしているため、本スタックでは process.env を直接参照します。
 * - 機微情報（*_SECRET, *_API_KEY）は SecureString で保存します。
 */
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StringParameter, ParameterType } from 'aws-cdk-lib/aws-ssm';
import { CfnParameter } from 'aws-cdk-lib';

export class SsmParametersStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';

    // 入力パラメータ（デプロイ時に渡す）
    const fireblocksApiKey = new CfnParameter(this, 'FireblocksApiKey', {
      type: 'String',
      noEcho: true,
      description: 'Fireblocks API Key',
      default: process.env.FIREBLOCKS_API_KEY ?? '',
    });
    const fireblocksApiSecret = new CfnParameter(this, 'FireblocksApiSecret', {
      type: 'String',
      noEcho: true,
      description: 'Fireblocks API Secret (private key contents)',
      default: process.env.FIREBLOCKS_API_SECRET ?? '',
    });
    const fireblocksVaultId = new CfnParameter(this, 'FireblocksVaultId', {
      type: 'String',
      description: 'Fireblocks Vault Account ID',
      default: process.env.FIREBLOCKS_VID_DEPLOYER ?? '',
    });
    const e2eMonitorAddress = new CfnParameter(this, 'E2eMonitorAddress', {
      type: 'String',
      description: 'E2eMonitor contract address (0x...)',
      default: process.env.CA_E2E_MONITOR ?? '',
    });
    const explorerApiKey = new CfnParameter(this, 'ExplorerApiKey', {
      type: 'String',
      noEcho: true,
      description: 'Explorer API Key (e.g., Polygonscan) - unified name',
      default: process.env.EXPLORER_API_KEY ?? '',
    });

    // SSM パラメータ作成（既存命名を踏襲）
    new StringParameter(this, 'ParamFireblocksApiKey', {
      parameterName: '/E2E-module/fireblocks/api_key',
      description: `Fireblocks API Key (${stage})`,
      stringValue: fireblocksApiKey.valueAsString,
      type: ParameterType.SECURE_STRING,
      simpleName: false,
    });

    new StringParameter(this, 'ParamFireblocksSecretKey', {
      parameterName: '/E2E-module/fireblocks/secret_key',
      description: `Fireblocks API Secret (${stage})`,
      stringValue: fireblocksApiSecret.valueAsString,
      type: ParameterType.SECURE_STRING,
      simpleName: false,
    });

    new StringParameter(this, 'ParamFireblocksVaultId', {
      parameterName: '/E2E-module/fireblocks/vault_id',
      description: `Fireblocks Vault ID (${stage})`,
      stringValue: fireblocksVaultId.valueAsString,
      type: ParameterType.STRING,
      simpleName: false,
    });

    new StringParameter(this, 'ParamE2eMonitorAddress', {
      parameterName: '/E2E-module/contract/e2e_monitor_address',
      description: `E2eMonitor Contract Address (${stage})`,
      stringValue: e2eMonitorAddress.valueAsString,
      type: ParameterType.STRING,
      simpleName: false,
    });

    // 新規: Explorer API Key を統一名で登録
    new StringParameter(this, 'ParamExplorerApiKey', {
      parameterName: '/E2E-module/explorer/api_key',
      description: `Explorer API Key (${stage})`,
      stringValue: explorerApiKey.valueAsString,
      type: ParameterType.SECURE_STRING,
      simpleName: false,
    });
  }
}


