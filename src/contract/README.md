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
npx hardhat ignition deploy ignition/modules/E2eMonitor.ts --network amoy # amoy
npx hardhat ignition deploy ignition/modules/E2eMonitor.ts --network polygon # mainnet
```

6. **コード検証**

```bash
npx hardhat verify --network amoy [contract_address] [deployer_address] # amoy
npx hardhat verify --network polygon [contract_address] [deployer_address] # mainnet
```

7. **ロールの付与**

```bash
node testScript/grantRole.js SENDER_ROLE [target_address] # amoy
node testScript/grantRole.js SENDER_ROLE [target_address] # mainnet
```

8. **イベントの送信**

```bash
node testScript/e2eping.js # amoy
node testScript/e2eping.js # mainnet
```
