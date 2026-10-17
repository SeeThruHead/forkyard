FROM node:24-bookworm
ARG TRAEFIK=3.5.3
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/traefik/traefik/releases/download/v${TRAEFIK}/traefik_v${TRAEFIK}_linux_$(dpkg --print-architecture).tar.gz" | tar -xz -C /usr/local/bin traefik
COPY forkyard.tgz /tmp/forkyard.tgz
RUN npm install -g /tmp/forkyard.tgz
COPY app /app
WORKDIR /app
ENV FORKYARD_PROXY=binary FORKYARD_TELEMETRY=false
