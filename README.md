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
RPC_URL=https://rpc-amoy.polygon.technology
CHAIN_ID=80002


### alchemy設定
RPC_ALCHEMY_URL=https://polygon-amoy.g.alchemy.com/v2
RPC_ALCHEMY_APIKEY=


### explorer設定
EXPLORER_API_URL=https://api-amoy.polygonscan.com/api # for polygonscan
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

## 監視/アラーム
すべて`e2emm-alerts-<stage>`へ通知。
- Step Functions Failed ≥ 1
- Email Ingest Failures（EMF）≥ 1
- Email Ingest Lambda Errors ≥ 1（バックアップ）
- tx-sender Lambda Errors ≥ 1 / Throttles ≥ 1
- SQS DLQ Visible ≥ 1

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