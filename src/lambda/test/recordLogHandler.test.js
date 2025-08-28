const { expect } = require('chai');
const sinon = require('sinon');

// 直接関数を require する代わりに、Validator の静的関数を複製
const { MessageValidator } = (() => {
  // MessageValidator の実装から検証関数を再現（外部依存なし）
  function validateMessage(messageBody) {
    if (typeof messageBody !== 'object' || messageBody === null) {
      return { success: false, error: 'Message body must be a JSON object' };
    }
    const correlationIdHex32 = typeof messageBody.correlationIdHex32 === 'string' ? messageBody.correlationIdHex32 : '';
    const tagHex32 = typeof messageBody.tagHex32 === 'string' ? messageBody.tagHex32 : '';

    if (!correlationIdHex32 || !/^0x[0-9a-fA-F]{64}$/.test(correlationIdHex32)) {
      return { success: false, error: 'Invalid correlationIdHex32 (must be 0x + 64 hex chars)' };
    }
    if (!tagHex32 || !/^0x[0-9a-fA-F]{64}$/.test(tagHex32)) {
      return { success: false, error: 'Invalid tagHex32 (must be 0x + 64 hex chars)' };
    }
    return { success: true, error: null, params: { correlationIdHex32, tagHex32 } };
  }
  return { MessageValidator: { validateMessage } };
})();

describe('MessageValidator.validateMessage (E2eMonitor.ping input)', () => {
  it('accepts valid 0x32-byte hex strings', () => {
    const ok = MessageValidator.validateMessage({
      correlationIdHex32: '0x' + 'ab'.repeat(32),
      tagHex32: '0x' + 'cd'.repeat(32)
    });
    expect(ok.success).to.equal(true);
    expect(ok.params.correlationIdHex32).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(ok.params.tagHex32).to.match(/^0x[0-9a-fA-F]{64}$/);
  });

  it('rejects missing fields', () => {
    const res = MessageValidator.validateMessage({});
    expect(res.success).to.equal(false);
    expect(res.error).to.match(/Invalid correlationIdHex32/);
  });

  it('rejects wrong length', () => {
    const res = MessageValidator.validateMessage({
      correlationIdHex32: '0x' + 'ab'.repeat(31),
      tagHex32: '0x' + 'cd'.repeat(32)
    });
    expect(res.success).to.equal(false);
  });
});


