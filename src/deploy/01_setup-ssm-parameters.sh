#!/bin/bash

# SSMパラメータの設定スクリプト
#
# 概要:
# - プロジェクトルートの .env と秘密鍵ファイルを読み込み、SSM Parameter Store に登録します。
# - Fireblocks 機密情報は SecureString、非機密は String として登録します。
#
# 使用法:
#   ./01_setup-ssm-parameters.sh [AWS_PROFILE]
#   例) ./01_setup-ssm-parameters.sh aaaaaa
#
# 参照する .env キー（必須）:
#   FIREBLOCKS_API_KEY         : Fireblocks API Key
#   FIREBLOCKS_SECRET_KEY_FILE : Fireblocks API Secret のファイルパス（相対 or 絶対）
#   FIREBLOCKS_VID_PINGER      : Fireblocks Vault Account ID (tx sender)
#   CA_E2E_MONITOR             : E2eMonitor コントラクトアドレス（0x...）
#   EXPLORER_API_KEY           : エクスプローラ（例: Polygonscan）APIキー
#
# 登録される SSM パラメータ名:
#   /E2E-module/fireblocks/api_key        (SecureString)
#   /E2E-module/fireblocks/secret_key     (SecureString)
#   /E2E-module/fireblocks/vault_id       (String)
#   /E2E-module/contract/e2e_monitor_address (String)
#   /E2E-module/explorer/api_key          (SecureString)

set -e

# AWS Profile
AWS_PROFILE=${1:-default}
AWS_PROFILE_OPTION="--profile $AWS_PROFILE"

# 作業ディレクトリの設定
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
ENV_FILE="$PROJECT_ROOT/.env"

# .envファイルが存在するか確認
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

echo "Loading configuration from $ENV_FILE..."
echo "Using AWS Profile: $AWS_PROFILE"

# .envファイルを読み込む
source "$ENV_FILE"

# 必要な変数が設定されているか確認
if [ -z "$FIREBLOCKS_API_KEY" ]; then
  echo "Error: FIREBLOCKS_API_KEY is not set in .env file"
  exit 1
fi

if [ -z "$FIREBLOCKS_SECRET_KEY_FILE" ]; then
  echo "Error: FIREBLOCKS_SECRET_KEY_FILE is not set in .env file"
  exit 1
fi

if [ -z "$FIREBLOCKS_VID_PINGER" ]; then
  echo "Error: FIREBLOCKS_VID_PINGER is not set in .env file"
  exit 1
fi

# E2eMonitor アドレス（.env から取得。個別に上書きする場合は export で設定可）
CA_E2E_MONITOR="${CA_E2E_MONITOR:-${CA_E2E_MONITOR:-}}"
if [ -z "$CA_E2E_MONITOR" ]; then
  echo "Error: CA_E2E_MONITOR is not set (.env or environment)"
  exit 1
fi

# Explorer API Key の確認
if [ -z "$EXPLORER_API_KEY" ]; then
  echo "Error: EXPLORER_API_KEY is not set in .env file"
  exit 1
fi

# 秘密鍵ファイルが存在するか確認
SECRET_KEY_FILE="$PROJECT_ROOT/$FIREBLOCKS_SECRET_KEY_FILE"
if [ ! -f "$SECRET_KEY_FILE" ]; then
  echo "Error: Secret key file not found at $SECRET_KEY_FILE"
  exit 1
fi

# 秘密鍵ファイルの内容を読み込む
FIREBLOCKS_API_SECRET=$(cat "$SECRET_KEY_FILE")

echo "Configuration loaded successfully."
echo "Fireblocks API Key: ${FIREBLOCKS_API_KEY:0:5}..."
echo "Fireblocks API Secret: [読み込み完了]"
echo "Fireblocks Vault ID: $FIREBLOCKS_VID_PINGER"
echo "E2eMonitor Contract Address: $CA_E2E_MONITOR"

# 設定内容を確認
# 確認プロンプト（YES=y でスキップ可能）
read -p "Do you want to upload these parameters to SSM? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Operation cancelled."
  exit 0
fi

# SSMパラメータの設定
echo "Creating SSM parameters..."

# Fireblocks API Key (SecureString)
aws ssm put-parameter \
  --name "/E2E-module/fireblocks/api_key" \
  --value "$FIREBLOCKS_API_KEY" \
  --type "SecureString" \
  --description "Fireblocks API Key" \
  --overwrite \
  $AWS_PROFILE_OPTION

# Fireblocks API Secret (SecureString)
aws ssm put-parameter \
  --name "/E2E-module/fireblocks/secret_key" \
  --value "$FIREBLOCKS_API_SECRET" \
  --type "SecureString" \
  --description "Fireblocks API Secret" \
  --overwrite \
  $AWS_PROFILE_OPTION

# Fireblocks Vault ID (String)
aws ssm put-parameter \
  --name "/E2E-module/fireblocks/vault_id" \
  --value "$FIREBLOCKS_VID_PINGER" \
  --type "String" \
  --description "Fireblocks Vault ID" \
  --overwrite \
  $AWS_PROFILE_OPTION

# E2eMonitor Contract Address (String)
aws ssm put-parameter \
  --name "/E2E-module/contract/e2e_monitor_address" \
  --value "$CA_E2E_MONITOR" \
  --type "String" \
  --description "E2eMonitor Contract Address" \
  --overwrite \
  $AWS_PROFILE_OPTION

# Explorer API Key (SecureString)
aws ssm put-parameter \
  --name "/E2E-module/explorer/api_key" \
  --value "$EXPLORER_API_KEY" \
  --type "SecureString" \
  --description "Explorer API Key" \
  --overwrite \
  $AWS_PROFILE_OPTION

echo "SSM parameters have been set up successfully."
echo ""
echo "Parameter names:"
echo "- /E2E-module/fireblocks/api_key"
echo "- /E2E-module/fireblocks/secret_key"
echo "- /E2E-module/fireblocks/vault_id"
echo "- /E2E-module/contract/e2e_monitor_address"
echo "- /E2E-module/explorer/api_key"