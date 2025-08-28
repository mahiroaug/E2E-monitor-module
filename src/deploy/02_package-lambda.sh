#!/bin/bash

# 環境変数（ENV）
# - S3_BUCKET     : パッケージをアップロードする S3 バケット名（既定: e2e-module-code）
# 引数
# - $1 VERSION    : パッケージ／Lambda 更新に使用するバージョン（例: v1）
# - $2 AWS_PROFILE: 使用する AWS プロファイル名（例: default）

# Lambda関数のコードをパッケージング化するスクリプト
# 使用法: ./02_package-lambda.sh <version> [AWS_PROFILE]

set -euo pipefail

# バージョン番号
VERSION=${1:-v1}

# AWS Profile
AWS_PROFILE=${2:-default}
AWS_PROFILE_OPTION="--profile $AWS_PROFILE"

# Lambda関数名
FUNCTION_NAME="E2E-module-tx-sender"

# 作業ディレクトリの設定
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
LAMBDA_DIR="$ROOT_DIR/src/lambda"
BUILD_DIR="$ROOT_DIR/build"
PACKAGE_FILE="$BUILD_DIR/lambda_code_$VERSION.zip"

# S3バケット名（小文字のみ許容）
S3_BUCKET=${S3_BUCKET:-e2e-module-code}

echo "Packaging TX-Sender Lambda function (version: $VERSION)"
echo "Using AWS Profile: $AWS_PROFILE"
echo "Target Lambda function: $FUNCTION_NAME"

# buildディレクトリの作成
mkdir -p "$BUILD_DIR"

# packageする前に古いzipを削除
if [ -f "$PACKAGE_FILE" ]; then
  rm "$PACKAGE_FILE"
  echo "Removed existing package file: $PACKAGE_FILE"
fi

# Lambda関数のディレクトリに移動
cd "$LAMBDA_DIR"

# 依存関係のインストール（再現性重視）
echo "Installing dependencies (omit dev)..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
npm prune --omit=dev

# zipファイルの作成
echo "Creating package..."
zip -r "$PACKAGE_FILE" . \
  -x "*.git*" "*.env*" "test-local.js" "test/**" "*.md" \
     "package.json" "package-lock.json" "*/\\.*" "*/\\.*/*" \
     "node_modules/aws-sdk/*"

echo "Package created: $PACKAGE_FILE"

# S3にアップロード
echo "Ensuring S3 bucket exists: $S3_BUCKET..."
if ! aws s3 ls "s3://$S3_BUCKET" $AWS_PROFILE_OPTION >/dev/null 2>&1; then
  aws s3 mb "s3://$S3_BUCKET" $AWS_PROFILE_OPTION
fi

echo "Uploading to S3 bucket: $S3_BUCKET..."
aws s3 cp "$PACKAGE_FILE" "s3://$S3_BUCKET/lambda_code_$VERSION.zip" $AWS_PROFILE_OPTION

echo "Upload completed"
echo "Package is available at: s3://$S3_BUCKET/lambda_code_$VERSION.zip" 

# Lambda関数のコードを更新
echo "Updating Lambda function: $FUNCTION_NAME..."
aws lambda update-function-code \
  --function-name $FUNCTION_NAME \
  --s3-bucket $S3_BUCKET \
  --s3-key "lambda_code_$VERSION.zip" \
  $AWS_PROFILE_OPTION

echo "Lambda function updated successfully!" 

