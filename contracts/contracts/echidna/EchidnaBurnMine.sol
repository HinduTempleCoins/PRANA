// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {BurnMine, IMintable} from "../BurnMine.sol";

/// @dev Test-only burnable input token. Echidna can mint itself a working balance via `faucet`.
contract EBurnableToken is ERC20Burnable {
    constructor() ERC20("EchidnaIn", "EIN") {}

    function faucet(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test-only mintable output token whose minter is the BurnMine. Tracks how much it has minted.
contract EMintableToken is ERC20, IMintable {
    address public minter;

    constructor() ERC20("EchidnaOut", "EOUT") {}

    function setMinter(address m) external {
        // one-shot: only settable while unset (the harness wires it in its constructor)
        require(minter == address(0), "minter set");
        minter = m;
    }

    function mint(address to, uint256 amount) external override {
        require(msg.sender == minter, "not minter");
        _mint(to, amount);
    }
}

/// @title EchidnaBurnMine — property/invariant harness for the BurnMine burn-to-mint sink.
/// @notice Boolean `echidna_*` properties below must ALWAYS hold under any sequence of fuzzed
///         calls. Run with: `echidna . --contract EchidnaBurnMine --config echidna.yaml`.
///
/// Conservation properties asserted:
///   1. Input is a TRUE sink: every unit `mine`d is burned — input.totalSupply only ever drops
///      by exactly totalBurned vs. the initial faucet amount; the mine never holds input.
///   2. Output minted == accounted: output.totalSupply == mine.totalMinted (no phantom mint).
///   3. Ratio integrity: totalMinted == quote(totalBurned) modulo per-call flooring, i.e.
///      totalMinted <= totalBurned * num / den (minting never exceeds the fixed ratio).
///   4. Monotonic counters: totalBurned and totalMinted never decrease.
contract EchidnaBurnMine {
    EBurnableToken public inTok;
    EMintableToken public outTok;
    BurnMine public mine;

    uint256 public constant RATIO_NUM = 3;
    uint256 public constant RATIO_DEN = 2;

    uint256 internal constant INITIAL_FAUCET = 1_000_000 ether;

    // ghosts for monotonicity checks
    uint256 internal lastBurned;
    uint256 internal lastMinted;

    constructor() {
        inTok = new EBurnableToken();
        outTok = new EMintableToken();
        mine = new BurnMine(inTok, IMintable(address(outTok)), RATIO_NUM, RATIO_DEN);
        outTok.setMinter(address(mine));

        // fund THIS harness (the only fuzzed caller) and pre-approve the mine.
        inTok.faucet(address(this), INITIAL_FAUCET);
        inTok.approve(address(mine), type(uint256).max);
    }

    // ---- fuzzed action ---------------------------------------------------

    /// @notice Echidna drives this; `raw` is bounded to a sane, affordable amount.
    function mineSome(uint256 raw) public {
        uint256 bal = inTok.balanceOf(address(this));
        if (bal == 0) return;
        uint256 amountIn = (raw % bal) + 1; // 1..bal
        if (mine.quote(amountIn) == 0) return; // skip dust that floors to 0 out
        mine.mine(amountIn);
    }

    // ---- properties ------------------------------------------------------

    /// (1) The mine is a pure pass-through sink: it must NEVER retain input tokens.
    function echidna_mine_holds_no_input() public view returns (bool) {
        return inTok.balanceOf(address(mine)) == 0;
    }

    /// (1') Input supply conservation: burned exactly accounts for the supply drop from the faucet.
    function echidna_input_supply_conserved() public view returns (bool) {
        return inTok.totalSupply() + mine.totalBurned() == INITIAL_FAUCET;
    }

    /// (2) Output supply equals what the mine recorded as minted — no phantom output.
    function echidna_output_supply_equals_minted() public view returns (bool) {
        return outTok.totalSupply() == mine.totalMinted();
    }

    /// (3) Ratio ceiling: minted output never exceeds the fixed ratio applied to burned input.
    function echidna_minted_within_ratio() public view returns (bool) {
        return mine.totalMinted() <= (mine.totalBurned() * RATIO_NUM) / RATIO_DEN;
    }

    /// (4) Counters are monotonic non-decreasing across the whole run.
    function echidna_counters_monotonic() public returns (bool) {
        bool ok = mine.totalBurned() >= lastBurned && mine.totalMinted() >= lastMinted;
        lastBurned = mine.totalBurned();
        lastMinted = mine.totalMinted();
        return ok;
    }
}
