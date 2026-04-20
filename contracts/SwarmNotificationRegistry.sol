// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract SwarmNotificationRegistry {
    event Notification(bytes32 indexed recipientHash, bytes encryptedPayload);

    function notify(bytes32 recipientHash, bytes calldata encryptedPayload) external {
        emit Notification(recipientHash, encryptedPayload);
    }
}
