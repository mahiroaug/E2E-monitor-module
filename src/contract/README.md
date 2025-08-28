# LogRecorder コントラクト

## 概要

このスマートコントラクトは、ブロックチェーン上でデータを記録・管理するための実装です。

## 機能

- ログデータの記録（ログ集約ID、タイムスロット、ユーザーリスト、ハッシュ値）
- 特定ログの取得
- オーナー権限による書き込み制御（OpenZeppelin Ownable使用）
- 記録イベントの発行

## 開発環境

- Solidity: ^0.8.20
- OpenZeppelin Contracts: ^5.3.0
- Hardhat: ^2.23.0
- TypeChain: ^8.3.2
- Hardhat Ignition: デプロイツール
- 推奨ノード: Node.js 20.x以上

## セットアップ手順

1. **依存関係のインストール**

```bash
npm install
```

2. **コントラクトのコンパイル**

```bash
npx hardhat compile
```

3. **テストの実行**

```bash
npx hardhat test
```

4. **ローカルでのデプロイ（開発用）**

```bash
# ローカルノードの起動
npx hardhat node

# Ignitionを使用したデプロイ
npx hardhat ignition deploy ignition/modules/E2eMonitor.ts --network localhost
```

5. **本番環境へのデプロイ**

```bash
# Ignitionを使用したデプロイ
npx hardhat ignition deploy ignition/modules/E2eMonitor.ts --network amoy
```

6. **コード検証**

```bash
npx hardhat verify --network amoy [contract_address]
```


## コントラクト使用方法

### ログデータの記録

```javascript
// コントラクトのインスタンスを取得
const logRecorder = await LogRecorder.deployed();

// ログデータの記録（オーナーアカウントからのみ実行可能）
await logRecorder.recordLog(
  logSetId,      // ログ集約ID (uint256)
  timeSlot,      // タイムスロット情報 (uint256)
  userList,      // ユーザーリスト (uint256[])
  hashValue      // ハッシュ値 (bytes32)
);
```

サンプルスクリプト

```bash
cd testScript
npm install
npm run record
```

### ログデータの取得

```javascript
// 特定のログを取得
const logData = await logRecorder.getLog(logSetId);
// logData[0]: ログ集約ID
// logData[1]: タイムスロット情報
// logData[2]: ユーザーリスト
// logData[3]: ハッシュ値
// logData[4]: タイムスタンプ
```

## イベント監視

```javascript
// LogRecordedイベントの監視
logRecorder.events.LogRecorded({}, (error, event) => {
  if (!error) {
    console.log("ログが記録されました:");
    console.log("ログ集約ID:", event.returnValues.logSetId);
    console.log("タイムスロット:", event.returnValues.timeSlot);
    console.log("ユーザーリスト:", event.returnValues.userList);
    console.log("ハッシュ値:", event.returnValues.hashValue);
  }
});
```
