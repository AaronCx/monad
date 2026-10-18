DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
export DEVELOPER_DIR
SIM ?= iPhone 17
DEST = platform=iOS Simulator,id=$(shell DEVELOPER_DIR=$(DEVELOPER_DIR) scripts/sim.sh '$(SIM)')

.PHONY: generate build test test-live
generate:
	xcodegen generate --spec project.yml

build: generate
	xcodebuild -project Monad.xcodeproj -scheme Monad -destination '$(DEST)' -derivedDataPath build/DerivedData build

test: generate
	xcodebuild -project Monad.xcodeproj -scheme Monad -destination '$(DEST)' -derivedDataPath build/DerivedData test

# Drives the app against a running monadd (default: the one on 7331 with ~/.monad/token).
# xcodebuild records the runner environment, token included, in its result bundle and
# build description, so the run happens in a temporary directory that is deleted
# afterwards; only the screenshots are kept, in build/live-screenshots. The simulator's own
# system log also records the launch environment, so point this at a throwaway daemon
# (its own MONAD_HOME) or rotate the token afterwards.
DAEMON_URL ?= http://127.0.0.1:7331
DAEMON_TOKEN_FILE ?= $(HOME)/.monad/token
test-live: generate
	@set -e; work=$$(mktemp -d); trap 'rm -rf "$$work"' EXIT; status=0; \
	TEST_RUNNER_MONAD_DAEMON_URL=$(DAEMON_URL) TEST_RUNNER_MONAD_DAEMON_TOKEN="$$(cat $(DAEMON_TOKEN_FILE))" \
	  xcodebuild -project Monad.xcodeproj -scheme Monad -destination '$(DEST)' \
	  -derivedDataPath "$$work/DerivedData" -resultBundlePath "$$work/live.xcresult" \
	  -only-testing:MonadUITests test || status=$$?; \
	rm -rf build/live-screenshots; mkdir -p build/live-screenshots; \
	xcrun xcresulttool export attachments --path "$$work/live.xcresult" --output-path "$$work/attachments" >/dev/null 2>&1 || true; \
	cp "$$work"/attachments/*.png build/live-screenshots/ 2>/dev/null || true; \
	exit $$status
