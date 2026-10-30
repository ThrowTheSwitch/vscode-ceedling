image_name := "vscode-ceedling-sidecar"
node_modules_volume := "vscode-ceedling-node-modules"
vscode_test_volume := "vscode-ceedling-vscode-test"
workspace := justfile_directory()

docker_run := "docker run --rm -i -e SIDECAR=1 -e VSCE_PAT -v " + workspace + ":/workspace -v " + node_modules_volume + ":/workspace/node_modules -v " + vscode_test_volume + ":/workspace/.vscode-test -w /workspace " + image_name

# just with no arguments lists recipes instead of running the first one defined
default:
    @just --list

# Run CMD directly if already inside the sidecar container, otherwise delegate to a fresh container run
[private]
_run CMD:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${SIDECAR:-0}" = "1" ]; then
        eval "{{CMD}}"
    else
        {{docker_run}} bash -c "just _run {{quote(CMD)}}"
    fi

# Build the sidecar image (no-op when already inside the container)
image:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${SIDECAR:-0}" != "1" ]; then
        docker build -t {{image_name}} -f sidecar/Dockerfile .
    fi

# Install dependencies
install: image
    just _run "npm install"

# Build the extension
build: image
    just _run "npm run build"

# Clean and rebuild the extension
rebuild: image
    just _run "npm run rebuild"

# Build the extension in watch mode
watch: image
    just _run "npm run watch"

# Run the test suite headlessly via Xvfb
test: image
    just _run "xvfb-run -a npm test"

# Lint the TypeScript sources and tests (findings only, for now)
lint: image
    just _run "npm run lint"

# Run the unit tests with coverage; the HTML report lands in coverage/index.html
coverage: image
    just _run "npm run test:coverage"

# Validate the compiled engine against a real Ceedling release in Docker, from the host (see docs/Development.md)
validate VERSION SUITE="all" *ARGS="": image
    just _run "npm run -s build:tests"
    SIDECAR_IMAGE={{image_name}} NODE_MODULES_VOLUME={{node_modules_volume}} tests/validation/run.sh {{VERSION}} {{SUITE}} {{ARGS}}

# Run every validation suite and probe on each supported Ceedling (MATRIX, CEEDLING_GEM: see tests/validation/matrix.sh)
validate-matrix *ARGS="": image
    just _run "npm run -s build:tests"
    SIDECAR_IMAGE={{image_name}} NODE_MODULES_VOLUME={{node_modules_volume}} tests/validation/matrix.sh {{ARGS}}

# Package the extension into a .vsix
package: image
    just _run "npm run package"

# Publish the extension to the marketplace (requires VSCE_PAT in the environment)
publish: image
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${VSCE_PAT:-}" ]; then
        echo "error: VSCE_PAT is not set" >&2
        exit 1
    fi
    just _run "npm run publish"

# Drop into an interactive shell in the container, with `just` recipes usable directly inside
shell: image
    docker run --rm -it \
        -e SIDECAR=1 \
        -e VSCE_PAT \
        -v {{workspace}}:/workspace \
        -v {{node_modules_volume}}:/workspace/node_modules \
        -v {{vscode_test_volume}}:/workspace/.vscode-test \
        -w /workspace \
        {{image_name}} bash

# Remove build output
clean: image
    just _run "npm run clean"
