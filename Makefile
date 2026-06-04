# PRANA — top-level developer Makefile.
#
# Thin, path-independent entry points that delegate to the per-area scripts and
# package.json test runners already in the tree. Nothing here re-implements
# logic: each target is a one-line wrapper so `make <thing>` works from the repo
# root regardless of the caller's cwd.
#
# Conventions:
#   - chain-*      : the L1 PoW node (chain/scripts/*).
#   - contracts-*  : the Solidity layer (contracts/, hardhat).
#   - games-*      : the HTML5 game suite (games/*/, node --test).
#   - adapters-*   : data adapters (tools/adapters/, node --test).
#   - exporter-*   : read-only chain exporters (tools/exporter/, node --test).
#   - wallet-*     : the PRANA wallet key-management core (wallet pkg, node --test).
#   - brain-*      : durable cross-session memory capture (tools/brain/*).
#   - dev-stack    : full local bring-up (chain + deploy + smoke).
#
# `make help` lists everything.

# Repo root = the directory this Makefile lives in.
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: help \
	chain-build chain-init chain-run chain-status \
	contracts-test contracts-coverage \
	games-test adapters-test exporter-test wallet-test \
	brain-capture dev-stack

## help: list the available targets
help:
	@echo "PRANA make targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'

# --- chain: the L1 PoW node ------------------------------------------------

## chain-build: build the PRANA geth node (delegates to chain/scripts/build.sh)
chain-build:
	@"$(ROOT)chain/scripts/build.sh"

## chain-init: initialize the datadir from genesis (chain/scripts/init.sh)
chain-init:
	@"$(ROOT)chain/scripts/init.sh"

## chain-run: run the single-node PoW miner (chain/scripts/run-miner.sh)
chain-run:
	@"$(ROOT)chain/scripts/run-miner.sh"

## chain-status: one-glance node health over JSON-RPC (chain/scripts/status.sh)
chain-status:
	@"$(ROOT)chain/scripts/status.sh"

# --- contracts: the Solidity layer -----------------------------------------

## contracts-test: run the hardhat contract test suite
contracts-test:
	@cd "$(ROOT)contracts" && npm test

## contracts-coverage: run solidity-coverage over the contract suite
contracts-coverage:
	@cd "$(ROOT)contracts" && npx hardhat coverage

# --- games: the HTML5 game suite -------------------------------------------

## games-test: run `npm test` in each games/* package that defines one
games-test:
	@for d in "$(ROOT)games"/*/; do \
		if [ -f "$$d/package.json" ] && node -e "process.exit((require('$$d/package.json').scripts||{}).test?0:1)" 2>/dev/null; then \
			echo "==> games: $$(basename $$d)"; \
			( cd "$$d" && npm test ) || exit $$?; \
		fi; \
	done

# --- adapters / exporter / wallet: node --test suites ----------------------

## adapters-test: run the data-adapter tests (node --test tools/adapters/)
adapters-test:
	@cd "$(ROOT)tools/adapters" && node --test

## exporter-test: run the chain-exporter tests (tools/exporter/, node --test)
exporter-test:
	@cd "$(ROOT)tools/exporter" && npm test

## wallet-test: run the PRANA wallet key-core tests (wallet pkg, node --test)
wallet-test:
	@cd "$(ROOT)akasha" && npm test

# --- brain: durable cross-session memory -----------------------------------

## brain-capture: refresh the mechanical Continue state from the latest transcript
brain-capture:
	@node "$(ROOT)tools/brain/brain-continue.mjs"

# --- dev-stack: full local bring-up ----------------------------------------

## dev-stack: init+mine+deploy+smoke the whole local stack (chain/scripts/dev-stack.sh)
dev-stack:
	@"$(ROOT)chain/scripts/dev-stack.sh"
