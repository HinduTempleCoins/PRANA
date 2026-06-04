const { ethers } = require("hardhat");

// Pack two uint128 into one bytes32: (hi << 128) | lo
function pack128(hi, lo) {
  return ethers.zeroPadValue(
    ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo)),
    32
  );
}

// Build a v0.7 PackedUserOperation as a JS object the contract ABI accepts (array/tuple).
function buildOp(fields) {
  return {
    sender: fields.sender,
    nonce: fields.nonce ?? 0n,
    initCode: fields.initCode ?? "0x",
    callData: fields.callData ?? "0x",
    accountGasLimits: fields.accountGasLimits ?? pack128(200000n, 200000n),
    preVerificationGas: fields.preVerificationGas ?? 50000n,
    gasFees: fields.gasFees ?? pack128(1n, 1n),
    paymasterAndData: fields.paymasterAndData ?? "0x",
    signature: fields.signature ?? "0x",
  };
}

// Replicate UserOperationLib.userOpHash on the JS side.
function userOpHash(op, entryPoint, chainId) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const inner = ethers.keccak256(
    coder.encode(
      [
        "address",
        "uint256",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
        "bytes32",
        "bytes32",
      ],
      [
        op.sender,
        op.nonce,
        ethers.keccak256(op.initCode),
        ethers.keccak256(op.callData),
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        ethers.keccak256(op.paymasterAndData),
      ]
    )
  );
  return ethers.keccak256(
    coder.encode(["bytes32", "address", "uint256"], [inner, entryPoint, chainId])
  );
}

// signature payload = abi.encode(signer, personal_sign(userOpHash))
async function signOp(op, signerWallet, declaredSigner, entryPoint, chainId) {
  const h = userOpHash(op, entryPoint, chainId);
  const sig = await signerWallet.signMessage(ethers.getBytes(h));
  const declared = declaredSigner ?? signerWallet.address;
  op.signature = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [declared, sig]
  );
  return op;
}

// Encode SmartAccount.execute(to, value, data) calldata.
function encodeExecute(account, to, value, data) {
  return account.interface.encodeFunctionData("execute", [to, value, data]);
}

module.exports = { pack128, buildOp, userOpHash, signOp, encodeExecute };
