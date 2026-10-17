FROM ubuntu:24.04 AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS bundle

ARG TARGETARCH
WORKDIR /opt/maple-download

RUN case "$TARGETARCH" in \
      arm64) target=aarch64-unknown-linux-gnu; checksum=32aa8a7bf27c32fa4b020b7c3cf8d080a61b2d4fea2c23f4d2b2d0b702c44d65 ;; \
      amd64) target=x86_64-unknown-linux-gnu; checksum=44dae17e2fecf4e3da3cedb78cbfc09ded3c865952532a4644d6119c062ad7f0 ;; \
      *) echo "Unsupported Maple architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --show-error --connect-timeout 10 --max-time 60 \
      "https://github.com/MapleTechLabs/maple/releases/download/v0.0.22/maple-v0.0.22-$target.tar.gz" \
      --output maple.tar.gz \
    && printf '%s  maple.tar.gz\n' "$checksum" | sha256sum --check --strict \
    && mkdir /opt/maple \
    && tar -xzf maple.tar.gz --strip-components=1 -C /opt/maple \
    && test -f /opt/maple/maple \
    && test -f /opt/maple/libchdb.so \
    && chmod +x /opt/maple/maple

FROM base

COPY --from=bundle /opt/maple /opt/maple
RUN groupadd --gid 10001 maple \
    && useradd --uid 10001 --gid maple --home-dir /var/lib/maple --no-create-home maple \
    && mkdir -p /var/lib/maple/data /var/lib/maple/runtime \
    && chown -R maple:maple /var/lib/maple

ENV HOME=/var/lib/maple MAPLE_NO_UPDATE_CHECK=1
USER maple
WORKDIR /var/lib/maple/runtime
EXPOSE 14318
ENTRYPOINT ["/opt/maple/maple"]
CMD ["start", "--offline", "--host", "0.0.0.0", "--port", "14318", "--data-dir", "/var/lib/maple/data"]
