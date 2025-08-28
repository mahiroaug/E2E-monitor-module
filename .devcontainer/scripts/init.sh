#!/bin/bash

# スクリプトの場所を取得
SCRIPT_DIR="$(dirname "$0")"

# 各セットアップスクリプトを実行
echo "🚀 Devcontainer初期化を開始します..."

echo "🔧 AWS CLIをインストール中..."
bash "$SCRIPT_DIR/install-aws-cli.sh"


echo "📦 npmパッケージをインストール中..."
npm install

echo "📦 サブディレクトリのnpmパッケージをインストール中..."
# プロジェクトルートディレクトリを取得
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# package.jsonを含むディレクトリを検索してnpm installを実行
find "$ROOT_DIR" -name "package.json" -not -path "*/node_modules/*" -not -path "$ROOT_DIR/package.json" | while read -r package_file; do
    package_dir="$(dirname "$package_file")"
    echo "📂 $package_dir のパッケージをインストール中..."
    (cd "$package_dir" && npm install)
done


echo "✅ Devcontainer初期化が完了しました！" 