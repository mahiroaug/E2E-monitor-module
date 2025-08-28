# LogRecorder テストスクリプト

このフォルダには、LogRecorderコントラクトを操作するためのテストスクリプトが含まれています。

## recordLog.js

このスクリプトは、FireblocksのAPIを使用してLogRecorderコントラクトの`recordLog`関数を呼び出します。

### 前提条件

- Node.js (v20以上)
- npm (v6以上)
- Fireblocksアカウントとアクセス権限
- `.env`ファイルに以下の環境変数が設定されていること:
  - `FIREBLOCKS_API_KEY`: FireblocksのAPIキー
  - `FIREBLOCKS_SECRET_KEY_FILE`: Fireblocksの秘密鍵ファイルへのパス
  - `FIREBLOCKS_VID_DEPLOYER`: Fireblocksのボールトアカウントのシグナーアドレス
  - `CA_TEST_NFT_AMOY`: デプロイされたLogRecorderコントラクトのアドレス

### インストール方法

```bash
cd src/contract/testScript
npm install
```

### 実行方法

```bash
npm run record
```

### カスタムパラメータを指定して実行

```bash
# 形式: node recordLog.js [logSetId] [timeSlot] [userList] [hash]
node recordLog.js 12345 1684567890 "[1,2,3,4,5]" "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

各パラメータの説明:
- `logSetId`: ログ集約ID（整数）
- `timeSlot`: タイムスロット（UNIXタイムスタンプ、整数）
- `userList`: ユーザーIDのリスト（JSON形式の配列）
- `hash`: ログデータのハッシュ値（32バイトの16進数文字列、0xプレフィックスあり/なし両対応）

### スクリプトの機能

1. Fireblocksの認証情報を使用してWeb3プロバイダーを初期化
2. LogRecorderコントラクトのインスタンスを作成
3. 以下のパラメータを使用して`recordLog`関数を呼び出し:
   - `logSetId`: 指定されたID、または現在のタイムスタンプ
   - `timeSlot`: 指定されたタイムスロット、または現在のUNIXタイムスタンプ
   - `userList`: 指定されたユーザーリスト、またはデフォルト値 [1, 2, 3]
   - `hash`: 指定された32バイトのハッシュ値、または全て0のデフォルトハッシュ
4. トランザクションの完了を待機
5. `getLog`関数を呼び出して、記録されたデータを確認

### 重要な仕様

このスクリプトでは、入力されたハッシュ値（`hash`パラメータ）をそのままブロックチェーンに記録します。ハッシュ値の計算は行わず、送信元である外部システムで事前に計算されたハッシュ値を使用します。

入力されるハッシュ値は以下の条件を満たす必要があります:
- 32バイト長（0xプレフィックスを除いて64文字）の16進数文字列
- オプションで0xプレフィックスを含む（含まれていない場合は自動的に追加）

例: `0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` 