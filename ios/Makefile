DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
export DEVELOPER_DIR
SIM ?= iPhone 17

.PHONY: generate build test test-live
generate:
	xcodegen generate --spec project.yml

build: generate
	xcodebuild -project Monad.xcodeproj -scheme Monad -destination 'platform=iOS Simulator,name=$(SIM)' -derivedDataPath build/DerivedData build

test: generate
	xcodebuild -project Monad.xcodeproj -scheme Monad -destination 'platform=iOS Simulator,name=$(SIM)' -derivedDataPath build/DerivedData test

# Drives the app against a running monadd (default: the one on 7331 with ~/.monad/token).
DAEMON_URL ?= http://127.0.0.1:7331
DAEMON_TOKEN_FILE ?= $(HOME)/.monad/token
test-live: generate
	TEST_RUNNER_MONAD_DAEMON_URL=$(DAEMON_URL) TEST_RUNNER_MONAD_DAEMON_TOKEN="$$(cat $(DAEMON_TOKEN_FILE))" \
	  xcodebuild -project Monad.xcodeproj -scheme Monad -destination 'platform=iOS Simulator,name=$(SIM)' \
	  -derivedDataPath build/DerivedData -resultBundlePath build/live-$$(date +%s).xcresult \
	  -only-testing:MonadUITests test
