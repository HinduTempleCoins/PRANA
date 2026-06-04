# PRANA contracts — unified test entrypoints for BOTH toolchains.
#
# Two test stacks live side by side in this directory and share the same source tree
# (contracts/contracts/):
#   - Hardhat (mocha/chai, JS)  -> `test/`,       artifacts in `artifacts/` + `cache/`
#   - Foundry (forge, Solidity) -> `test-forge/`, artifacts in `out-forge/` + `cache-forge/`
# Their output dirs are kept separate (see foundry.toml) so neither clobbers the other.
#
# forge may be installed under ~/.foundry/bin (foundryup default) which is not always on
# PATH in a fresh shell — resolve it here so `make` works without sourcing a profile.
FORGE := $(shell command -v forge 2>/dev/null || echo $(HOME)/.foundry/bin/forge)
NPX   := npx

.PHONY: test test-forge test-hardhat coverage fmt-check fmt snapshot build clean help

## test: run BOTH test suites (forge + hardhat).
test: test-forge test-hardhat

## test-forge: run the Foundry (Solidity) tests.
test-forge:
	$(FORGE) test -vv

## test-hardhat: run the Hardhat (mocha) tests.
test-hardhat:
	$(NPX) hardhat test

## build: compile with forge (Hardhat compiles on demand during its own tests).
build:
	$(FORGE) build

## coverage: forge line/branch coverage for the Solidity tests.
coverage:
	$(FORGE) coverage

# fmt targets cover only the forge-owned tree (tests + scripts). The shared production
# sources in contracts/contracts/ are NOT reformatted here — they are co-owned with Hardhat
# and their style is intentionally left as authored.
## fmt-check: verify Solidity formatting (forge fmt) without writing — CI gate.
fmt-check:
	$(FORGE) fmt --check test-forge/ script/

## fmt: apply forge fmt to the forge-owned Solidity (tests + scripts).
fmt:
	$(FORGE) fmt test-forge/ script/

## snapshot: write/refresh the gas snapshot (.gas-snapshot).
snapshot:
	$(FORGE) snapshot

## clean: remove forge build output (leaves Hardhat artifacts alone).
clean:
	$(FORGE) clean

## help: list targets.
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
