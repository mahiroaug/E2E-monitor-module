# Lambda デプロイ手順

このディレクトリには、messageをSQSから受け取り処理するLambda関数をデプロイするためのスクリプトが含まれています。

## アーキテクチャ上の位置づけ

このLambda関数は、E2E-moduleプロジェクトのシステムアーキテクチャにおいて以下の役割を担います：

1. AWS SQSからログデータを受信
2. Fireblocks APIを使用してブロックチェーンにログデータを記録
3. システム全体の中では、以下のフローで動作します：
   ```
   NUC → AWS SQS → Lambda → Fireblocks API → ブロックチェーン
   ```

## デプロイ手順

### 前提条件

- AWS CLI（認証情報設定済み）
- Node.js 20.x以上のインストール
- プロジェクトルートに`.env`ファイルが存在し、必要な設定が含まれていること
- プロジェクトルートにFireblocksの秘密鍵ファイルが配置されていること

### .envファイルのサンプル

プロジェクトルートに`.env`ファイルを作成

```
# Fireblocks API設定
FIREBLOCKS_API_KEY=abcdef-12345-6789-xyz-abcdefghijkl
FIREBLOCKS_SECRET_KEY_FILE=fireblocks_secret.key
FIREBLOCKS_VID_DEPLOYER=1234

# コントラクト設定
CA_TEST_NFT_AMOY=0x1234567890abcdef1234567890abcdef12345678
```

### 1. スクリプトに実行権限を付与

```bash
chmod +x 01_setup-ssm-parameters.sh 02_package-lambda.sh
```

### 2. SSMパラメータの設定

`.env`ファイルからFireblocks API認証情報や契約アドレスを読み込み、SSMに設定

```bash
cd src/deploy
./01_setup-ssm-parameters.sh [profile_name]
```

`.env`ファイルには以下の変数が必要
- `FIREBLOCKS_API_KEY`: Fireblocks APIキー
- `FIREBLOCKS_SECRET_KEY_FILE`: 秘密鍵ファイルのパス（プロジェクトルートからの相対パス）
- `FIREBLOCKS_VID_DEPLOYER`: Fireblocks Vault ID
- `CA_TEST_NFT_AMOY`: LogRecorderコントラクトアドレス

### 3. Lambdaデプロイ

```bash
cd src/deploy
./02_package-lambda.sh v1 [profile_name]
```

## 動確

```bash
# SQSキューのURLを取得
SQS_URL=$(aws cloudformation describe-stacks \
  --stack-name web3-blockchain-logger \
  --query "Stacks[0].Outputs[?OutputKey=='SQSQueueURL'].OutputValue" \
  --output text \
  --profile [profile_name])

# テストメッセージを送信
aws sqs send-message \
  --queue-url "$SQS_URL" \
  --message-body '{"log_set_id":999999001,"time_slot":1620000000,"user_list":[1,2,3],"hash":"0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}' \
  --profile [profile_name]
```
