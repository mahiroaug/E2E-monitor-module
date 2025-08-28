const { handler: recordLogHandler } = require('./recordLogHandler');

// Lambda関数のエントリーポイント
exports.handler = async (event, context) => {
  return await recordLogHandler(event, context);
}; 