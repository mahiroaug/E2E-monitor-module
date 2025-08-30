## 機能
## プロジェクト概要

ブロックチェーン監視サービスの稼働確認を、トランザクションの外形監視で定期的に自動検証します。試験実行でコントラクトイベントを発火し、監視サービスが送るメール内の TxHash を起点に on-chain のイベント内容（correlationId）を突合します。失敗時は CloudWatch 経由で SNS 通知します。

## 全体アーキテクチャ

- スケジューラ: EventBridge（rate/cron）
- オーケストレーション: Step Functions（SQS 送信→結果ポーリング）
- 試験トランザクション発行: tx-sender Lambda（Fireblocks→E2eMonitor.sol `ping`）
- 監視メール受信: SES 受信ルール → S3 保存 → email-ingest Lambda
- 判定: email-ingest Lambda が `txHash` を基にエクスプローラAPIで該当トランザクションのイベントを照会し、`correlationId` 一致で成功、DynamoDB に記録
- 通知: CloudWatch Logs メトリクスフィルタ + アラーム → SNS

フロー（要約）
1) EventBridge が Step Functions を起動（`correlationId` 生成）
2) Step Functions が SQS に試験メッセージ送信（`correlationIdHex32`, `tagHex32`）
3) tx-sender Lambda が `E2eMonitor.ping(correlationId, tag, clientTimestamp, nonce)` を送信（Fireblocks 経由で `clientTimestamp`/`nonce` を付与）
4) 監視サービスがイベント検出→メール送信（本文に TxHash）
5) SES→S3→email-ingest Lambda がメールを解析、`txHash`→エクスプローラAPI→イベント(`E2ePing`)の `correlationId` 突合→DynamoDB `SUCCESS` 記録
6) Step Functions が DynamoDB をポーリングして成功検出で終了。未検出でタイムアウト→失敗ログ→SNS 通知

## リポジトリ構成（宣言的）

```
.
├─ cdk/                         # IaC（AWS CDK v2 / TypeScript）
│  ├─ bin/app.ts
│  └─ lib/
│     ├─ email-ingest-stack.ts
│     ├─ messaging-stack.ts
│     ├─ state-machine-stack.ts
│     ├─ storage-stack.ts
│     └─ notification-stack.ts
├─ src/
│  ├─ contract/                 # Hardhat 一式（E2eMonitor.sol / Ignition など）
│  ├─ lambda/                   # tx-sender（tx-sender/index.js）, email-ingest
│  └─ deploy/                   # SSM 初期化スクリプト等
├─ docs/                        # アーキ/ランブック等
└─ README.md
```

実体のソース配置は以下を参照してください:
- コントラクト: `src/contract/`
- 送信 Lambda: `src/lambda/`
- CDK: `cdk/`

## コントラクト仕様（E2eMonitor.sol）

- 権限制御: `AccessControl`（`SENDER_ROLE` を付与した送信者のみ `ping` 可）
- イベント:
  - `event E2ePing(bytes32 indexed correlationId, address indexed sender, uint256 clientTimestamp, uint256 nonce, uint256 blockTimestamp, bytes32 tag)`
- 関数:
  - `function ping(bytes32 correlationId, bytes32 tag, uint256 clientTimestamp, uint256 nonce) external onlyRole(SENDER_ROLE)`

検証ロジックは TxHash→エクスプローラAPI（例: Polygonscan API）→イベント取得で `correlationId` を突合します。

## SQS メッセージ（試験 Tx 指示）


## 主要パラメータ（例：SSM/環境変数）

- Fireblocks 送信系(SSM): `/E2E-module/fireblocks/api_key`, `/E2E-module/fireblocks/secret_key`, `/E2E-module/fireblocks/vault_id`
- コントラクト(SSM): `/E2E-module/contract/e2e_monitor_address`
- エクスプローラ API: 環境変数 `EXPLORER_API_URL`（例: `https://api-amoy.polygonscan.com/api`）, `EXPLORER_API_KEY`
- SES 設定: 許可送信元/受信メールアドレス
- 通知: SNS トピック ARN（CDK 出力でも可）
- スケジュール/タイムアウト: Step Functions の待機/最大実行時間

## デプロイ手順（開発環境）

1) devcontainer を開く（初回で AWS CLI / CDK がインストールされます）
2) .env を作成
3) SSM にパラメータを設定
   - `cd src/deploy && ./01_setup-ssm-parameters.sh <profile_name>`
4) 依存インストール
   - `cd cdk && npm install`
   - `cd src/contract && npm install`
   - `cd src/lambda && npm install`
5) コントラクトのビルド（必要に応じてデプロイ）
   - `cd src/contract && npx hardhat compile`
   - デプロイ/ロール付与は Hardhat スクリプト/Ignition を用意（今後追加）
6) CDK
   - `cd cdk && npm run build`
   - `npm run deploy -- --profile <profile_name>`

7) SES Receipt Rule Set のアクティブ化（手動）
   - 受信メールを有効にするには、対象リージョンでReceipt Rule Setをアクティブ化します。
   - 備考: そのリージョンでアクティブなRule Setは常に1つです。本コマンドで切り替わります。

## Lambda 構成と役割

- **tx-sender（`e2emm-tx-sender-<stage>`）**
  - **場所**: `src/lambda/tx-sender/index.js`
  - **トリガー**: SQS `e2emm-main-queue-<stage>`（1件ずつ）
  - **入力**: `messageBody`（JSON文字列）
    - 形式: `{ "correlationIdHex32": "0x...64", "tagHex32": "0x...64" }`
  - **動作**: Fireblocks経由で `E2eMonitor.ping(correlationIdHex32, tagHex32, clientTimestamp, nonce)` を送信
  - **環境**: `SSM_PREFIX=/E2E-module/`（必要な鍵等はSSMから取得）
  - **出力**: なし（非同期）／失敗時はDLQへ

- **email-ingest（`e2emm-email-ingest-<stage>`）**
  - **場所**: `src/lambda/email-ingest/index.js`
  - **トリガー**: EventBridge（S3 Object Created for `e2emm-email-bucket-<stage>/ses/<stage>/`）
  - **入力**: S3に保存された受信メール（本文からTxHash抽出）
  - **動作**: エクスプローラAPIでTxの `E2ePing` を取得し、`correlationId` を突合。成功時にDynamoDBへ結果をupsertし、メトリクスを記録
  - **環境**: `RESULTS_TABLE`, `CONTRACT_ADDRESS`, `EXPLORER_API_URL`, `EXPLORER_API_KEY`
  - **出力**: DDB（`e2emm-results-<stage>`）へのレコード（キー: `correlationId`）

- **prepare-message（Step Functions 内で呼び出し）**
  - **場所**: `src/lambda/prepare-message/index.js`
  - **トリガー**: Step Functions `e2emm-state-machine-<stage>` からの同期呼び出し
  - **入力**: `{ correlationId: string, tagSeed?: string }`
  - **動作**: `correlationId`/`tagSeed` を bytes32（`correlationIdHex32`/`tagHex32`）へ変換し、SQS用 `messageBody`（JSON文字列）を組み立て
  - **出力**: `{ correlationIdHex32, tagHex32, messageBody }`

### Step Functions におけるIDの扱い
- 実行開始時に `correlationId` が未指定なら `States.UUID()` で自動生成します。
- `prepare-message` の出力で `messageBody` を上書きし、同時にDDB検索キーとして `correlationIdHex32` を採用します。


## 運用・判定ロジック

- 成功条件: email-ingest Lambda がメールから抽出した `txHash` に対しエクスプローラAPIで `E2ePing(correlationId=一致)` を検出し、DynamoDB に `SUCCESS` を upsert。Step Functions が検出し正常終了。
- 失敗条件: メール未着、解析不可、receipt 未取得、`correlationId` 不一致、タイムアウト。
- 通知: 失敗時ログを CloudWatch メトリクス化し、アラーム閾値 >= 1 で SNS 通知。

## ランブック（抜粋）

- 失敗時に確認するもの:
  - Step Functions 実行ログ（`correlationId`）
  - SQS → tx-sender Lambda 実行ログ（Fireblocks 送信可否）
  - SES 受信/S3 保存の有無、email-ingest Lambda の解析ログ
  - RPC 応答（`eth_getTransactionReceipt`）、Polygonscan 参照（`E2ePing` の `topics[1]` が `correlationId`）
- 再実行: Step Functions を手動再実行、必要に応じて `correlationId` を変更

## 受け入れ条件

- 正常系:
  - スケジュール起動で `E2eMonitor.ping` が発火し、メール到達後に `correlationId` 一致で成功検出、実行が Success 終了
- 失敗系:
  - 上記が所定時間で満たされず Fail となり、SNS 通知が発火
- セキュリティ:
  - 送信鍵は Secrets/SSM で管理、S3/DDB/SNS/SQS は KMS 暗号化、IAM は最小権限

## 今後の拡張

- ネットワークの多重化（並列起動）
- `minConfirmations` 対応の強化（リオーグ対策）
- ダッシュボード（成功/失敗件数、SLO）

- ログ集約データ（ログ集約ID、ユーザーリスト、ハッシュ値）の受信
- 受信データの検証と処理
- ブロックチェーンネットワークとの連携
- 堅牢なエラーハンドリングとデッドレターキュー

## 開発環境のセットアップ

### 前提条件

- AWS CLI（認証情報設定済み）
- Node.js20以上
- AWS アカウント


3. **メインスタックのデプロイ**:

```bash
sdk及びGUIから実行ください
```

## NUCとの連携方法

AWS SQSにデータを送信するには、以下の情報が必要です：

1. **認証情報の取得**:

    ```bash
    # Secret ARNの取得
    SECRET_ARN=$(aws cloudformation describe-stacks \
        --stack-name E2E-module-log-aggregation \
        --query "Stacks[0].Outputs[?OutputKey=='LogSenderCredentialsSecretArn'].OutputValue" \
        --output text)

    # シークレットの値を取得
    aws secretsmanager get-secret-value --secret-id $SECRET_ARN
    ```

2. **SQSキューURLの取得**:

    ```bash
    aws cloudformation describe-stacks \
        --stack-name E2E-module-log-aggregation \
        --query "Stacks[0].Outputs[?OutputKey=='SQSQueueURL'].OutputValue" \
        --output text
    ```

3. **SQS Push例**:
    ```bash
    xxxは任意にProfileに置き換えてください。
    SQS_URL=$(aws cloudformation describe-stacks \
        --stack-name web3-blockchain-logger \
        --query "Stacks[0].Outputs[?OutputKey=='SQSQueueURL'].OutputValue" \
        --output text \
        --profile xxx)
    ```

    ```bash
    aws sqs send-message \
        --queue-url $SQS_URL \
        --message-body '{"log_set_id":999999001,"time_slot":1620000000,"user_list":[1,2,3],"hash":"0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}' \
        --profile xxx
     ```


4. **メッセージフォーマット**:

    ```json
    {
    "log_set_id": number(integer), // ログ集約ID（必須） Unique規制
    "time_slot": number(integer),  // unixtime秒（必須）
    "user_list": [integer],        // ユーザーリスト（必須）
    "hash": "string(hex)",           // ハッシュ値(sha256)（必須）
    }
    ```
    ```

## 運用監視

- **CloudWatch Logs**: Lambda実行ログの確認
- **SQS指標**: キューの状態監視
- **DLQモニタリング**: 処理失敗メッセージの確認
 - **カスタムメトリクス**: `E2E/EmailIngest Failures`（関数/理由次元）に対してアラーム設定

## Step Functions 手動起動例（入力）

```json
{
  "correlationId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "messageBody": "{\"correlationIdHex32\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"tagHex32\":\"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}"
}
```

備考:
- `messageBody` は JSON 文字列（ダブルクォートをエスケープ）。
- `correlationId` は DDB での検索キー。`email-ingest` が `SUCCESS` を upsert すると検出される。

---


## 2025/08/29 MVP版（命名規則: `e2emm-*-<stage>`）

- SQS : `e2emm-main-queue-<stage>` / DLQ: `e2emm-main-dlq-<stage>`
- Lambda : `e2emm-tx-sender-<stage>`, `e2emm-email-ingest-<stage>`
- DynamoDB : `e2emm-results-<stage>`
- S3 : `e2emm-email-bucket-<stage>`
- SNS : `e2emm-alerts-<stage>`
- Step Functions : `e2emm-state-machine-<stage>`
- Fireblocks : `OPTAGE_2 (Testnet)`
- Fireblocks API-user : `API-mahiro-t2-signer`
- Blockchain : `Polygon Amoy (chain_ID=80002)`
- Smart Contract Owner : `0x084466a05dfeb359E57f985F1B0a1EbabBE77e9A`
- Smart Contract (E2eMonitor) : ``
- [polygonscan(E2eMonitor)](https://amoy.polygonscan.com/address/)


