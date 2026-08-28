# syntax=docker/dockerfile:1.7
# Build context is the directory that contains BOTH repositories:
#   docker build -f remote-console/Dockerfile -t ghcr.io/ruohki/remote-console:dev ..

# ── web UI ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /src/remote-console/web
COPY remote-console/web/package.json remote-console/web/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY remote-console/web ./
RUN npm run build

# ── server ─────────────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS server
WORKDIR /src
# The protocol crate is a path dependency into the sibling agent repository.
COPY remote-agent/crates/protocol remote-agent/crates/protocol
COPY remote-console/Cargo.toml remote-console/Cargo.lock* remote-console/
COPY remote-console/server remote-console/server
COPY --from=web /src/remote-console/web/dist remote-console/web/dist
WORKDIR /src/remote-console
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/remote-console/target \
    cargo build --release --locked -p remote-console \
    && cp target/release/remote-console /usr/local/bin/remote-console

# ── runtime ────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /data console \
    && mkdir -p /data && chown console:console /data
COPY --from=server /usr/local/bin/remote-console /usr/local/bin/remote-console
USER console
WORKDIR /data
VOLUME ["/data"]
ENV DATABASE_URL="sqlite:///data/console.db?mode=rwc" \
    LISTEN_ADDR="0.0.0.0:8080" \
    RUST_LOG="info"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /api/info HTTP/1.0\r\n\r\n' >&3 && head -c 12 <&3 | grep -q 200"]
ENTRYPOINT ["remote-console"]
CMD ["serve"]
