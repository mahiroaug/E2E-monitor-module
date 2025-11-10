# X-Ray Tracing有効化 設計書

## 概要
E2E監視システム全体にAWS X-Ray Tracingを有効化し、分散トレーシングによるパフォーマンス分析とトラブルシューティングを可能にする。

## 目的
1. **分散トレーシング**: Step Functions → Lambda → DynamoDB → SQS → メール受信フロー全体を可視化
2. **パフォーマンス分析**: 各ステップの実行時間を詳細に把握し、ボトルネックを特定
3. **エラー追跡**: どのステップでエラーが発生したかを視覚的に確認
4. **サービスマップ**: サービス間の依存関係を可視化
5. **レイテンシー分析**: 各サービス呼び出しのレイテンシーを分析

## 対象リソース

### 1. Step Functions
- **ファイル**: `cdk/lib/state-machine-stack.ts`
- **リソース**: `e2emm-state-machine-<stage>`
- **設定**: `tracingEnabled: true`

### 2. Lambda関数（4つ）

#### 2.1 init-record
- **ファイル**: `cdk/lib/state-machine-stack.ts`
- **関数名**: `InitRecordFn`
- **役割**: DynamoDBに初期レコードを作成
- **呼び出し元**: Step Functions

#### 2.2 prepare-message
- **ファイル**: `cdk/lib/state-machine-stack.ts`
- **関数名**: `PrepareMessageFn`
- **役割**: correlationIdHex32/tagHex32を生成
- **呼び出し元**: Step Functions

#### 2.3 tx-sender
- **ファイル**: `cdk/lib/messaging-stack.ts`
- **関数名**: `TxSenderFn`
- **役割**: ブロックチェーンにトランザクションを送信
- **呼び出し元**: SQS

#### 2.4 email-ingest
- **ファイル**: `cdk/lib/email-ingest-stack.ts`
- **関数名**: `EmailParserFn`
- **役割**: メールからTxHashを抽出し、DynamoDBを更新
- **呼び出し元**: EventBridge (S3 Object Created)

## 実装設計

### 1. 環境変数による制御

環境変数 `ENABLE_XRAY_TRACING` を追加し、有効/無効を切り替え可能にする。

- **デフォルト**: `true`（有効化）
- **設定箇所**: `.env` または `.env_<stage>` ファイル
- **値**: `true` / `false`（文字列）

### 2. 実装箇所

#### 2.1 Step Functions (`state-machine-stack.ts`)

```typescript
// 環境変数から読み込み
const enableXRayTracing = process.env.ENABLE_XRAY_TRACING !== 'false'; // デフォルトtrue

this.machine = new StateMachine(this, 'E2eMachine', {
  // ... 既存の設定
  tracingEnabled: enableXRayTracing, // ← 追加
});
```

#### 2.2 Lambda関数（全4つ）

各Lambda関数に `tracing` プロパティを追加：

```typescript
import { Tracing } from 'aws-cdk-lib/aws-lambda';

// 環境変数から読み込み
const enableXRayTracing = process.env.ENABLE_XRAY_TRACING !== 'false';

// 各Lambda関数に追加
const initRecordFn = new NodejsFunction(this, 'InitRecordFn', {
  // ... 既存の設定
  tracing: enableXRayTracing ? Tracing.ACTIVE : Tracing.DISABLED, // ← 追加
});
```

**対象Lambda関数:**
1. `initRecordFn` (`state-machine-stack.ts`)
2. `prepareMessageFn` (`state-machine-stack.ts`)
3. `txSenderFn` (`messaging-stack.ts`)
4. `parserFn` (`email-ingest-stack.ts`)

### 3. IAM権限

CDKが自動的に以下の権限を付与：
- `xray:PutTraceSegments`
- `xray:PutTelemetryRecords`

**注意**: 明示的なIAMポリシー追加は不要（CDKが自動処理）

## コスト影響

### X-Rayの料金体系（2024年時点）

1. **無料枠**:
   - 最初の10万トレース/月: 無料
   - ストレージ: 最初の1GB/月: 無料

2. **従量課金**:
   - トレース: 10万トレース超: $5/100万トレース
   - ストレージ: 1GB超: $0.50/GB/月

### 想定コスト

**前提条件:**
- 実行間隔: 15分（1日96回）
- 1実行あたりのトレース数: 約10-15トレース（Step Functions + Lambda呼び出し）

**月間トレース数:**
- 96回/日 × 30日 = 2,880実行/月
- 2,880実行 × 12トレース = 約34,560トレース/月

**結論**: 無料枠内（10万トレース/月）に収まるため、追加コストは発生しない見込み。

## トレースフロー

```
EventBridge (Schedule)
  └─ Step Functions (e2emm-state-machine)
      ├─ Lambda (init-record)
      │   └─ DynamoDB (e2emm-results)
      ├─ Lambda (prepare-message)
      ├─ SQS (e2emm-main-queue)
      │   └─ Lambda (tx-sender)
      │       └─ ブロックチェーン (外部)
      └─ DynamoDB (ポーリング)
          └─ [メール受信待ち]
              └─ EventBridge (S3 Object Created)
                  └─ Lambda (email-ingest)
                      ├─ S3 (メール取得)
                      ├─ ブロックチェーンRPC (イベント照会)
                      └─ DynamoDB (更新)
```

## 実装手順

1. **環境変数の追加**
   - `.env` または `.env_<stage>` に `ENABLE_XRAY_TRACING=true` を追加

2. **CDKコードの修正**
   - `state-machine-stack.ts`: Step Functionsと2つのLambda関数に設定追加
   - `messaging-stack.ts`: tx-sender Lambda関数に設定追加
   - `email-ingest-stack.ts`: email-ingest Lambda関数に設定追加

3. **デプロイ**
   - 変更をデプロイして動作確認

4. **X-Rayコンソールでの確認**
   - AWS X-Rayコンソールでトレースを確認
   - サービスマップで依存関係を確認

## 期待される効果

1. **パフォーマンス分析**
   - メール受信の遅延（SES → S3 → email-ingest）の可視化
   - DynamoDBクエリ時間の把握
   - Step Functionsのポーリングループの各イテレーション時間の追跡

2. **トラブルシューティング**
   - エラー発生箇所の特定が容易に
   - レイテンシーの高いサービスを特定
   - ボトルネックの可視化

3. **運用改善**
   - パフォーマンス改善の優先順位付け
   - リソース最適化の判断材料

## 注意事項

1. **セキュリティ**
   - X-Rayトレースにはリクエスト/レスポンスのメタデータが含まれる
   - 機密情報（APIキー、パスワードなど）はトレースに含まれないが、URLやパラメータ名は含まれる可能性がある

2. **パフォーマンス**
   - X-Ray Tracingは軽微なオーバーヘッド（数ミリ秒）を追加する
   - 本番環境でも問題ないレベル

3. **データ保持**
   - X-Rayのトレースデータは30日間保持される
   - 長期保存が必要な場合は、CloudWatch Logs Insightsと組み合わせる

## 参考資料

- [AWS X-Ray Documentation](https://docs.aws.amazon.com/xray/)
- [Step Functions X-Ray Tracing](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-xray-tracing.html)
- [Lambda X-Ray Tracing](https://docs.aws.amazon.com/lambda/latest/dg/services-xray.html)

