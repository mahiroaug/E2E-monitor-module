# E2E-module ログ集約システム API仕様

## SQSメッセージフォーマット

### リクエスト仕様

メッセージ本文: JSON形式

```json
{
  "log_set_id": number(integer),    // ログ集約ID（必須）
  "time_slot": number(integer),     // 関連ユーザーリスト（必須）
  "user_list": [number(integer)],   // ログ内容のハッシュ値（必須）
  "hash": "string",                 // タイムスタンプ（必須）
}
```

サンプルメッセージ
```json
{
  "log_set_id": 999999001,
  "time_slot": 1620000000,
  "user_list": [1, 2, 3],
  "hash": "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```
