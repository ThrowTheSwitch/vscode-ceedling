# A Ceedling release with the sidecar's Node added, so the validation suites in tests/validation can
# drive the compiled engine against real Ceedling. tests/validation/run.sh builds and tags the
# images, one per Ceedling version or local gem.
#
# Every published release's installation also sits under /opt/ceedling/<version>, so a suite can
# select another Ceedling than the image's own, as a project vendoring one does. A local gem, given
# as the build context `gem` holding one .gem file, joins them there. GEM_MODE=install also makes
# it the image's own Ceedling in place of CEEDLING's.
ARG CEEDLING=1.2.2
ARG SIDECAR=vscode-ceedling-sidecar
FROM ${SIDECAR} AS sidecar
FROM throwtheswitch/madsciencelab-plugins:1.0.0 AS ceedling-1.0.0
FROM throwtheswitch/madsciencelab-plugins:1.1.10 AS ceedling-1.1.10
FROM throwtheswitch/madsciencelab-plugins:1.2.0 AS ceedling-1.2.0
FROM throwtheswitch/madsciencelab-plugins:1.2.1 AS ceedling-1.2.1
FROM throwtheswitch/madsciencelab-plugins:1.2.2 AS ceedling-1.2.2
# No gem unless the build passes the context. run.sh always passes one; see there.
FROM scratch AS gem

FROM throwtheswitch/madsciencelab-plugins:${CEEDLING}
ARG CEEDLING
ARG GEM_MODE=opt
COPY --from=sidecar /usr/local/bin/node /usr/local/bin/node
USER root
# strace: the discovery syscall probe traces Ceedling's file access
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends strace >/dev/null && rm -rf /var/lib/apt/lists/*
# The 1.0.0 image runs Ruby 3.1, the others 3.3.
COPY --from=ceedling-1.0.0 /var/lib/gems/3.1.0/gems/ceedling-1.0.0 /opt/ceedling/1.0.0
COPY --from=ceedling-1.1.10 /var/lib/gems/3.3.0/gems/ceedling-1.1.10 /opt/ceedling/1.1.10
COPY --from=ceedling-1.2.0 /var/lib/gems/3.3.0/gems/ceedling-1.2.0 /opt/ceedling/1.2.0
COPY --from=ceedling-1.2.1 /var/lib/gems/3.3.0/gems/ceedling-1.2.1 /opt/ceedling/1.2.1
COPY --from=ceedling-1.2.2 /var/lib/gems/3.3.0/gems/ceedling-1.2.2 /opt/ceedling/1.2.2
COPY --from=gem / /tmp/gem/
# A gem unpacks to the files it installs, replacing a published release of its version. Installing
# it uninstalls the base release, so `ceedling` and Gem::Specification find only the gem.
RUN set -e; for gem in /tmp/gem/*.gem; do \
        [ -e "$gem" ] || continue; \
        version=$(ruby -rrubygems/package -e 'print Gem::Package.new(ARGV[0]).spec.version' "$gem"); \
        rm -rf "/opt/ceedling/$version"; \
        gem unpack "$gem" --target /tmp/unpacked >/dev/null && mv /tmp/unpacked/ceedling-* "/opt/ceedling/$version"; \
        chmod -R a+rX "/opt/ceedling/$version"; \
        if [ "$GEM_MODE" = install ]; then \
            gem install --local --no-document "$gem" >/dev/null; \
            if [ "$version" != "$CEEDLING" ]; then gem uninstall -x ceedling -v "$CEEDLING" >/dev/null; fi; \
        fi; \
    done; \
    rm -rf /tmp/gem /tmp/unpacked
# /ws: where each run builds its projects, inside the container
RUN mkdir /ws && chown dev /ws
USER dev
# ReportGenerator, where the image has it, installs as a .NET global tool
ENV PATH=$PATH:/home/dev/.dotnet/tools
