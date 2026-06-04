// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MultiSigWallet — minimal m-of-n multisig (treasury / owner key)
/// @notice The cold side of the hot/cold split: no single key can move funds. Owners submit a tx,
///         confirm it, and once `threshold` confirmations are reached anyone-of-owners can execute.
///         Deliberately small and auditable. For production-grade, prefer canonical Gnosis Safe.
contract MultiSigWallet {
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }
    Transaction[] public transactions;
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    event Submit(uint256 indexed id, address indexed to, uint256 value);
    event Confirm(uint256 indexed id, address indexed owner);
    event Execute(uint256 indexed id);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "not owner");
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        require(owners_.length > 0 && threshold_ > 0 && threshold_ <= owners_.length, "bad config");
        for (uint256 i; i < owners_.length; i++) {
            address o = owners_[i];
            require(o != address(0) && !isOwner[o], "bad owner");
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
    }

    receive() external payable {}

    function submit(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 id) {
        id = transactions.length;
        transactions.push(Transaction(to, value, data, false, 0));
        emit Submit(id, to, value);
    }

    function confirm(uint256 id) external onlyOwner {
        require(id < transactions.length, "no tx");
        Transaction storage t = transactions[id];
        require(!t.executed, "executed");
        require(!confirmedBy[id][msg.sender], "already confirmed");
        confirmedBy[id][msg.sender] = true;
        t.confirmations += 1;
        emit Confirm(id, msg.sender);
    }

    function execute(uint256 id) external onlyOwner {
        Transaction storage t = transactions[id];
        require(!t.executed, "executed");
        require(t.confirmations >= threshold, "insufficient confirmations");
        t.executed = true;
        (bool ok, ) = t.to.call{value: t.value}(t.data);
        require(ok, "call failed");
        emit Execute(id);
    }

    function ownerCount() external view returns (uint256) { return owners.length; }
    function txCount() external view returns (uint256) { return transactions.length; }
}
