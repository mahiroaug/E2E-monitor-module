## 概要（運用者・デプロイ担当向け）
E2E監視を自動実行し、メール経由でTxIDを取得→オンチェーンの`E2ePing`イベントと突合して成否を判定します。失敗はSNSに通知されます。

## 前提条件
- AWS CLI, CDK(v2), Node.js 20
- AWSプロファイル
- SES受信対応リージョン（本構成は ap-northeast-1 を想定）

## 環境変数/.env（抜粋）

```
STAGE=dev

FIREBLOCKS_API_KEY=
FIREBLOCKS_SECRET_KEY_FILE=

### スマートコントラクトデプロイ用
FIREBLOCKS_VID_DEPLOYER=              ### Fireblocks Vault Account ID (deployer)
POLYGONSCAN_API_KEY=                  ### スマートコントラクト検証用APIキー


### E2E監視用
FIREBLOCKS_VID_PINGER=                ### Fireblocks Vault Account ID (tx sender)
CA_E2E_MONITOR=                       ### コントラクトアドレス
EXPLORER_API_URL=https://api-amoy.polygonscan.com/api
EXPLORER_API_KEY=                     ### エクスプローラAPIキー
SES_RECIPIENTS=                       ### 受信メールアドレス
EVENT_RATE_MINUTES=60                 ### 実行間隔（分）
SF_TOTAL_ATTEMPTS=3                   ### 最大試行回数（1回5分でタイムアウト（WARNアラーム）、3回試行の場合15分でERRORアラーム）


### network設定
RPC_URL=https://polygon-rpc.com # fot Hardhat network setting | scripts | mainnet
CHAIN_ID=137 # fot Hardhat network setting | scripts | mainnet
RPC_URL=https://rpc-amoy.polygon.technology # fot Hardhat network setting | scripts | amoy
CHAIN_ID=80002 # fot Hardhat network setting | scripts | amoy


### alchemy設定
RPC_ALCHEMY_URL=https://polygon-mainnet.g.alchemy.com/v2 # mainnet
RPC_ALCHEMY_URL=https://polygon-amoy.g.alchemy.com/v2 # amoy
RPC_ALCHEMY_APIKEY=


### explorer設定
EXPLORER_API_URL=https://api.polygonscan.com/api # for polygonscan mainnet
EXPLORER_API_URL=https://api-amoy.polygonscan.com/api # for polygonscan amoy
EXPLORER_API_KEY=

### ロギング設定
LOG_LEVEL=debug
```


## デプロイ手順
1. devcontainerを起動
   - 自動で各パッケージがインストールされます
2. CDKビルド
   - `cd cdk && npm run build`
3. デプロイ
   - 全体: `npm run deploy -- --profile <profile>`
   - 個別（例）:
     - `npx cdk deploy e2emm-stack-storage-<stage> --context stage=<stage> --profile <profile>`
     - `npx cdk deploy e2emm-stack-messaging-<stage> --context stage=<stage> --profile <profile>`
     - `npx cdk deploy e2emm-stack-email-ingest-<stage> --context stage=<stage> --profile <profile>`
     - `npx cdk deploy e2emm-stack-statemachine-<stage> --context stage=<stage> --profile <profile>`

## 初期有効化（必須）
1. SES Receipt Rule Set をアクティブ化（ap-northeast-1）
   - `aws ses set-active-receipt-rule-set --rule-set-name e2emm-ruleset-<stage> --region ap-northeast-1 --profile <profile>`
2. ドメイン受信のDNS(MX)設定
   - `10 inbound-smtp.ap-northeast-1.amazonaws.com`
3. 送信ドメインの検証/サンドボックス解除（送信リージョン）


## 運用
- 正常フロー
  1) Step FunctionsがUUIDで`correlationId`生成
  2) `prepare-message`が`correlationIdHex32/tagHex32`を組成→SQSへ
  3) `tx-sender`が`E2eMonitor.ping`送信
  4) 監視メールがSES→S3→`email-ingest`でTxHash抽出・イベント照会→DDBへ`SUCCESS`
  5) Step FunctionsがDDB検出でSuccess終了

- 手動トリガ
  - Step Functions入力は空で可（空オブジェクト）。

## 監視/アラーム（設計）
全アラートは `e2emm-alerts-<stage>` に通知されます（OK通知も有効）。

- Step Functions（`E2E/StateMachine`）
  - AttemptFailed（WARN）
    - 生成: 各Attemptが約5分で失敗すると1カウント
    - アラーム: 数式メトリクス（AF-S, 5分）
      - AF = AttemptFailed sum(5m), S = Success sum(5m)
      - 条件: AF − S > 0（次のAttempt成功で相殺→自動復旧）
    - 補助: `AttemptFailedInfo`（Attempt/TotalAttempts/PollCount）
  - FinalFailed（ERROR）
    - 生成: 全Attempt失敗で1カウント
    - アラーム: 数式メトリクス（FF-S, 復旧窓）
      - 復旧窓: `max(EVENT_RATE_MINUTES, 60)` 分
      - 条件: FF − S > 0（次のStateMachine成功で自動復旧）
    - 補助: `FinalFailedInfo`（Attempt/TotalAttempts/PollCount）
  - Success（自動復旧用）
    - 生成: ステートマシン成功直前に1カウント
    - 目的: 上記AF-S / FF-Sの相殺用
  - 重要度表現
    - `AttemptFailedWarn` → description/タグ: severity=warning
    - `StateMachineFailedError` → description/タグ: severity=critical

- Email Ingest（カスタム名前空間: `E2E/EmailIngest`）
  - Failures（Hard Fail）
    - メトリクス: `Failures`（5分, sum）
    - アラーム: 連続2期間（10分）で閾値≥1
  - SoftMiss（TxID/Correlation未検出の軽微な未達）
    - メトリクス: `SoftMiss`（5分, sum）
    - アラーム: 5分で≥3
  - バックアップ
    - `AWS/Lambda Errors` ≥1（5分, sum）

- その他
  - tx-sender: `AWS/Lambda Errors` ≥1、`Throttles` ≥1
  - SQS: DLQ `ApproximateNumberOfMessagesVisible` ≥1

補足:
- Step Functionsの成功条件（デフォルト: AND）
  - correlationResolved == true AND balanceReceived == true（DDB単一レコード判定）
- リトライ/タイムアウト
  - 初回待機 90秒 → 15秒ポーリング×最大14回 ≒ 1試行 ≒ 約5分
  - 総タイムアウト: `5 * SF_TOTAL_ATTEMPTS + 1` 分
  - AttemptFailed（WARN）は試行失敗ごと、FinalFailed（ERROR）は全試行失敗時に発火

## ログ
- 保持期間: 1年（Step Functions / email-ingest / tx-sender）

## トラブルシュート（要点）
- 受信しない
  - SES ルールセットがアクティブか
  - MXレコード（inbound-smtp.ap-northeast-1.amazonaws.com）
  - SESサプレッション: `aws sesv2 get-suppressed-destination --email-address <addr>`
- `email-ingest`でTx抽出不可
  - メール本文の`/tx/0x...`リンクや`TxID:`表記を確認
  - `EXPLORER_API_URL/KEY` 正当性
- DDBが更新されない
  - コントラクトアドレス一致（`CONTRACT_ADDRESS`）
  - `E2ePing`の`topics[1]`が`correlationIdHex32`と一致
- ステートマシンがTimeout
  - 実行間隔・待機秒（15秒）と全体タイムアウト（5分）の調整

## スタック名（`<stage>`付き）
- storage: `e2emm-stack-storage-<stage>`
- messaging: `e2emm-stack-messaging-<stage>`
- email-ingest: `e2emm-stack-email-ingest-<stage>`
- statemachine: `e2emm-stack-statemachine-<stage>`
- ses-receive: `e2emm-stack-ses-receive-<stage>`
- notification: `e2emm-stack-notification-<stage>`