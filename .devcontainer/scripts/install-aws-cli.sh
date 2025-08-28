#!/bin/bash

echo "📦 AWS CLIをインストール中..."

# CPUアーキテクチャを検出
ARCH=$(uname -m)
echo "🔍 検出されたCPUアーキテクチャ: $ARCH"

# 一時ディレクトリを作成
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# アーキテクチャに基づいて適切なAWS CLIをダウンロード
if [ "$ARCH" = "x86_64" ]; then
    echo "⬇️ x86_64用のAWS CLIをダウンロード中..."
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    echo "⬇️ ARM64用のAWS CLIをダウンロード中..."
    curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
else
    echo "❌ サポートされていないアーキテクチャです: $ARCH"
    exit 1
fi

# ダウンロードしたファイルを解凍
echo "📦 ファイルを解凍中..."
unzip awscliv2.zip

# AWS CLIをインストール
echo "🔧 AWS CLIをインストール中..."
sudo ./aws/install

# 一時ディレクトリを削除
cd - > /dev/null
rm -rf "$TEMP_DIR"

echo "✅ AWS CLIのインストールが完了しました！"

# バージョン情報を表示
echo "📊 インストールされたバージョン情報："
aws --version

# AWS CDKをインストール
echo "📦 AWS CDKをインストール中..."
npm install -g aws-cdk

echo "✅ AWS CDKのインストールが完了しました！"

# CDKバージョン情報を表示
cdk --version 