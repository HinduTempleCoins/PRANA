// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
// Pulls OZ TimelockController into the build so the devnet can deploy a real timelock.
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
