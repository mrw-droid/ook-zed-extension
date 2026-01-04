.PHONY: build clean install-ext

AGENT_DIR := agent
EXT_DIR := extension
BINARY := ook
ARCHIVE := $(EXT_DIR)/ook-darwin-aarch64.tar.gz

build: $(ARCHIVE)

$(ARCHIVE): $(AGENT_DIR)/target/release/$(BINARY)
	tar -czvf $@ -C $(AGENT_DIR)/target/release $(BINARY)

$(AGENT_DIR)/target/release/$(BINARY): $(AGENT_DIR)/src/*.rs $(AGENT_DIR)/Cargo.toml
	cd $(AGENT_DIR) && cargo build --release

clean:
	cd $(AGENT_DIR) && cargo clean
	rm -f $(ARCHIVE)

# Rebuild and prompt to install in Zed
install-ext: build
	@echo "Archive ready at $(ARCHIVE)"
	@echo "Use Zed's 'Install Dev Extension' and select: $(EXT_DIR)/"
