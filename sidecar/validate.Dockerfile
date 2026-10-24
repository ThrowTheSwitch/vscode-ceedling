# A Ceedling release with the sidecar's Node added, so the validation suites in tests/validation can
# drive the compiled engine against real Ceedling. tests/validation/run.sh builds one image per
# Ceedling version, tagged vscode-ceedling-validate:<version>.
ARG CEEDLING=1.2.1
ARG SIDECAR=vscode-ceedling-sidecar
FROM ${SIDECAR} AS sidecar

FROM throwtheswitch/madsciencelab-plugins:${CEEDLING}
COPY --from=sidecar /usr/local/bin/node /usr/local/bin/node
USER root
# strace: the discovery syscall probe traces Ceedling's file access
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends strace >/dev/null && rm -rf /var/lib/apt/lists/*
# /ws: where each run builds its projects, inside the container
RUN mkdir /ws && chown dev /ws
USER dev
# ReportGenerator, where the image has it, installs as a .NET global tool
ENV PATH=$PATH:/home/dev/.dotnet/tools
