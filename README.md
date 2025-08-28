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
2) Step Functions が SQS に試験メッセージ送信（`correlationId`, `contractAddress`, `tag` 等）
3) tx-sender Lambda が `E2eMonitor.ping(correlationId, tag)` を送信（Fireblocks 経由）
4) 監視サービスがイベント検出→メール送信（本文に TxHash）
5) SES→S3→email-ingest Lambda がメールを解析、`txHash`→エクスプローラAPI→イベント(`E2ePing`)の `correlationId` 突合→DynamoDB `SUCCESS` 記録
6) Step Functions が DynamoDB をポーリングして成功検出で終了。未検出でタイムアウト→失敗ログ→SNS 通知

## リポジトリ構成（宣言的）

```
.
├─ cdk/                         # IaC（AWS CDK v2 / TypeScript）
│  ├─ bin/app.ts                # エントリ
│  └─ lib/
│     ├─ email-ingest-stack.ts  # SES→S3→email-ingest Lambda
│     ├─ messaging-stack.ts     # SQS(+DLQ)
│     ├─ state-machine-stack.ts # Step Functions / EventBridge
│     ├─ storage-stack.ts       # DynamoDB / S3（メール保存）
│     └─ notification-stack.ts  # SNS / CloudWatch（アラーム）
├─ contracts/                   # Hardhat 一式（src/contract）
│  └─ contracts/E2eMonitor.sol  # event E2ePing / function ping
├─ services/
│  ├─ tx-sender/                # SQS→Fireblocks→E2eMonitor.ping（src/lambda 相当）
│  └─ email-ingest/             # SES(S3)→メール解析→エクスプローラAPI→DDB
├─ docs/                        # アーキ/ランブック等
└─ .devcontainer/               # 開発環境（AWS CLI/CDK 等のセットアップ）
```

実体のソース配置は以下を参照してください:
- コントラクト: `src/contract/`
- 送信 Lambda: `src/lambda/`
- CDK: `cdk/`

## コントラクト仕様（E2eMonitor.sol）

- 権限制御: `AccessControl`（`SENDER_ROLE` を付与した送信者のみ `ping` 可）
- イベント:
  - `event E2ePing(bytes32 indexed correlationId, address indexed sender, uint256 timestamp, bytes32 tag)`
- 関数:
  - `function ping(bytes32 correlationId, bytes32 tag) external onlyRole(SENDER_ROLE)`

検証ロジックは TxHash→エクスプローラAPI（例: Polygonscan API）→イベント取得で `correlationId` を突合します。

## SQS メッセージ（試験 Tx 指示）

```
{
  "correlationIdHex32": "0x...64桁",
  "contractAddress": "0xContract",
  "tagHex32": "0x...64桁",
  "minConfirmations": 0 | 1 | 2,  // 任意。email-ingest 判定は receipt 到達で十分なら 0
  "network": "polygon-amoy"
}
```

## 主要パラメータ（例：SSM/環境変数）

- Fireblocks 送信系: `/E2E/fireblocks/api_key`, `/E2E/fireblocks/secret_key`, `/E2E/fireblocks/vault_id`
- エクスプローラ API キー: `/E2E/explorer/api_key`（例: Polygonscan）
- コントラクト: `/E2E/contract/e2e_monitor_address`
- SES 設定: 許可送信元/受信メールアドレス
- 通知: SNS トピック ARN（CDK 出力でも可）
- スケジュール/タイムアウト: Step Functions の待機/最大実行時間

## デプロイ手順（開発環境）

1) devcontainer を開く（初回で AWS CLI / CDK がインストールされます）
2) 依存インストール
   - `cd cdk && npm install`
   - `cd src/contract && npm install`
   - `cd src/lambda && npm install`
3) コントラクトのビルド（必要に応じてデプロイ）
   - `cd src/contract && npx hardhat compile`
   - デプロイ/ロール付与は Hardhat スクリプト/Ignition を用意（今後追加）
4) CDK
   - `cd cdk && npm run build`
   - 初回: `npx cdk bootstrap`
   - デプロイ: `npm run deploy`

## 運用・判定ロジック

- 成功条件: email-ingest Lambda がメールから抽出した `txHash` に対しエクスプローラAPIで `E2ePing(correlationId=一致)` を検出し、DynamoDB に `SUCCESS` を upsert。Step Functions が検出し正常終了。
- 失敗条件: メール未着、解析不可、receipt 未取得、`correlationId` 不一致、タイムアウト。
- 通知: 失敗時ログを CloudWatch メトリクス化し、アラーム閾値 >= 1 で SNS 通知。

## ランブック（抜粋）

- 失敗時に確認するもの:
  - Step Functions 実行ログ（`correlationId`）
  - SQS → tx-sender Lambda 実行ログ（Fireblocks 送信可否）
  - SES 受信/S3 保存の有無、email-ingest Lambda の解析ログ
  - RPC 応答（`eth_getTransactionReceipt`）、Polygonscan 参照
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

---


## 2025/04/22 MVP版

- SQS : `E2E-module-log-aggregation-queue`
- Lambda : `E2E-module-log-processor` version `v1`
- Fireblocks : `OPTAGE_2 (Testnet)`
- Fireblocks API-user : `API-mahiro-t2-signer`
- Blockchain : `Polygon Amoy (chain_ID=80002)`
- Smart Contract Owner : `0x084466a05dfeb359E57f985F1B0a1EbabBE77e9A`
- Smart Contract (LogRecorderV2) : `0x2856f26889a2E2dD107D7099FeA3115eB54146d3`
- [polygonscan(LogRecorderV2)](https://amoy.polygonscan.com/address/0x2856f26889a2E2dD107D7099FeA3115eB54146d3)


