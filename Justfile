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

# The documentation site's recipes run on the host, in the .docsenv/ Python venv, not the sidecar.
# Deploys push the gh-pages branch with your own Git credentials (see docs/Development.md).

# Run CMD in .docsenv/, which `just docs-install` creates, never in another venv or the sidecar
[private]
_docs CMD:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${SIDECAR:-0}" = "1" ]; then
        echo "error: the docs recipes run on the host, not in the sidecar" >&2
        exit 1
    fi
    if [ ! -f .docsenv/bin/activate ]; then
        echo "error: no .docsenv/; run 'just docs-install' first" >&2
        exit 1
    fi
    source .docsenv/bin/activate
    eval "{{CMD}}"

# Refuse a docs version that isn't a release's x.y.z, or a working tree with uncommitted changes, which mike would publish under HEAD's commit
[private]
_docs-deployable VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! [[ {{quote(VERSION)}} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "error: a docs version is a release's x.y.z, not "{{quote(VERSION)}} >&2
        exit 1
    fi
    if [ -n "$(git status --porcelain)" ]; then
        echo "error: commit or stash your changes first; mike deploys the working tree as HEAD's commit" >&2
        exit 1
    fi
    git fetch -q origin

# Install the documentation site's tools (mkdocs, Material, mike) into .docsenv/, a host Python venv
docs-install:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -d .docsenv ] || python3 -m venv .docsenv
    .docsenv/bin/pip install -q --upgrade pip
    .docsenv/bin/pip install -q -r docs/requirements.txt

# Build the documentation site into site/, failing on any warning, such as a broken link
docs-build:
    just _docs "mkdocs build --strict"

# Serve the documentation site at http://127.0.0.1:8000, rebuilding as pages change
docs-serve:
    just _docs "mkdocs serve"

# Browse the deployed versions of the documentation site at http://127.0.0.1:8000
docs-preview:
    git fetch -q origin
    just _docs "mike serve"

# Deploy one release's documentation to GitHub Pages without moving 'latest', e.g. to revise an older version
docs-deploy VERSION: (_docs-deployable VERSION) docs-build
    just _docs "mike deploy --push {{VERSION}}"

# Deploy a release's documentation to GitHub Pages, make it 'latest', and have the site's root open 'latest'
docs-deploy-latest VERSION: (_docs-deployable VERSION) docs-build
    just _docs "mike deploy --push --update-aliases {{VERSION}} latest"
    just _docs "mike set-default --push latest"
