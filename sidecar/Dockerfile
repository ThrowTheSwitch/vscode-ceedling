FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    # ca-certificates: needed for TLS-verified apt/npm/curl fetches below and at container run time
    # curl: fetches the `just` install script
    # git: vsce/npm inspect repo metadata (e.g. `git log`) when packaging
    ca-certificates \
    curl \
    git \
    # xvfb + xauth + libnss3..libcups2: headless display (xvfb-run needs xauth for its Xauthority
    # file) and Chromium/Electron runtime libs required by @vscode/test-electron, which downloads
    # and launches a real VS Code instance for `npm test`
    xvfb \
    xauth \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libasound2 \
    libxss1 \
    libgbm1 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcups2 \
    && rm -rf /var/lib/apt/lists/*

# just: lets Justfile recipes run identically inside `just shell` sessions, not only from the host
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin

WORKDIR /workspace
