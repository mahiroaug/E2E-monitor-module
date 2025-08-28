// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title E2E Monitoring Event Emitter
/// @notice 監視用のイベントを発火するだけの最小コントラクト
contract E2eMonitor is AccessControl {
    bytes32 public constant SENDER_ROLE = keccak256("SENDER_ROLE");

    /// @dev 監視イベント。外形監視でエクスプローラからイベント検索し、correlationId を同定する
    /// @param correlationId 相関 ID（bytes32）
    /// @param sender イベント送信元（EOA）
    /// @param clientTimestamp 呼び出し側が付与したタイムスタンプ（任意精度）
    /// @param nonce 呼び出し側が参照した EOA の nonce（任意）
    /// @param blockTimestamp ブロックタイムスタンプ（オンチェーン）
    /// @param tag 任意タグ
    event E2ePing(
        bytes32 indexed correlationId,
        address indexed sender,
        uint256 clientTimestamp,
        uint256 nonce,
        uint256 blockTimestamp,
        bytes32 tag
    );

    /// @param initialSender 初期の送信許可アドレス（0 の場合は付与なし）
    constructor(address initialSender) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (initialSender != address(0)) {
            _grantRole(SENDER_ROLE, initialSender);
        }
    }

    /// @notice 監視イベントを発火
    /// @param correlationId 32byte 固定の相関 ID
    /// @param tag 任意の補助タグ（用途識別等）
    /// @param clientTimestamp 呼び出し側が付与するタイムスタンプ
    /// @param nonce 呼び出し側が参照した EOA の nonce 値
    function ping(
        bytes32 correlationId,
        bytes32 tag,
        uint256 clientTimestamp,
        uint256 nonce
    ) external onlyRole(SENDER_ROLE) {
        emit E2ePing(correlationId, msg.sender, clientTimestamp, nonce, block.timestamp, tag);
    }
}


