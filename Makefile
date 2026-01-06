.PHONY: all clean extension agent agent-darwin-aarch64 agent-linux-amd64 \
        docker docker-amd64 docker-aarch64 install-ext

# Directories
AGENT_DIR := agent
EXT_SRC_DIR := $(AGENT_DIR)/extension
TARGET_DIR := target
EXT_TARGET_DIR := $(TARGET_DIR)/extension

# Binary name
BINARY := ook

# Docker image name
DOCKER_IMAGE := ook-bridge

# Agent tarballs
AGENT_DARWIN_AARCH64 := $(TARGET_DIR)/ook-darwin-aarch64.tar.gz
AGENT_LINUX_AMD64 := $(TARGET_DIR)/ook-linux-amd64.tar.gz

# Docker exports
DOCKER_AMD64_TAR := $(TARGET_DIR)/$(DOCKER_IMAGE)-amd64.tar.gz
DOCKER_AARCH64_TAR := $(TARGET_DIR)/$(DOCKER_IMAGE)-aarch64.tar.gz

# Default: build extension with darwin-aarch64 agent
all: extension agent-darwin-aarch64

# Copy extension files to target directory
extension: $(EXT_TARGET_DIR)

$(EXT_TARGET_DIR): $(EXT_SRC_DIR)/extension.toml $(EXT_SRC_DIR)/icon.svg
	@mkdir -p $(EXT_TARGET_DIR)
	cp $(EXT_SRC_DIR)/extension.toml $(EXT_TARGET_DIR)/
	cp $(EXT_SRC_DIR)/icon.svg $(EXT_TARGET_DIR)/

# Build all agent tarballs
agent: agent-darwin-aarch64 agent-linux-amd64

# Darwin aarch64 agent
agent-darwin-aarch64: $(AGENT_DARWIN_AARCH64)

$(AGENT_DARWIN_AARCH64): $(AGENT_DIR)/target/aarch64-apple-darwin/release/$(BINARY)
	@mkdir -p $(TARGET_DIR)
	tar -czvf $@ -C $(AGENT_DIR)/target/aarch64-apple-darwin/release $(BINARY)

$(AGENT_DIR)/target/aarch64-apple-darwin/release/$(BINARY): $(AGENT_DIR)/src/*.rs $(AGENT_DIR)/Cargo.toml
	cd $(AGENT_DIR) && cargo build --release --target aarch64-apple-darwin

# Linux amd64 agent (requires cross or appropriate toolchain)
agent-linux-amd64: $(AGENT_LINUX_AMD64)

$(AGENT_LINUX_AMD64): $(AGENT_DIR)/target/x86_64-unknown-linux-gnu/release/$(BINARY)
	@mkdir -p $(TARGET_DIR)
	tar -czvf $@ -C $(AGENT_DIR)/target/x86_64-unknown-linux-gnu/release $(BINARY)

$(AGENT_DIR)/target/x86_64-unknown-linux-gnu/release/$(BINARY): $(AGENT_DIR)/src/*.rs $(AGENT_DIR)/Cargo.toml
	cd $(AGENT_DIR) && cross build --release --target x86_64-unknown-linux-gnu

# Docker builds
docker: docker-amd64 docker-aarch64

docker-amd64: $(DOCKER_AMD64_TAR)

$(DOCKER_AMD64_TAR):
	@mkdir -p $(TARGET_DIR)
	docker buildx build --platform linux/amd64 -t $(DOCKER_IMAGE):amd64 --load bridge/
	docker save $(DOCKER_IMAGE):amd64 | gzip > $@

docker-aarch64: $(DOCKER_AARCH64_TAR)

$(DOCKER_AARCH64_TAR):
	@mkdir -p $(TARGET_DIR)
	docker buildx build --platform linux/arm64 -t $(DOCKER_IMAGE):aarch64 --load bridge/
	docker save $(DOCKER_IMAGE):aarch64 | gzip > $@

clean:
	cd $(AGENT_DIR) && cargo clean
	rm -rf $(TARGET_DIR)

# Build and prompt to install in Zed
install-ext: extension agent-darwin-aarch64
	@cp $(AGENT_DARWIN_AARCH64) $(EXT_TARGET_DIR)/
	@echo "Extension ready at $(EXT_TARGET_DIR)/"
	@echo "Use Zed's 'Install Dev Extension' and select that directory"
