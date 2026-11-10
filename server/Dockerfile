# The Grid multiplayer relay (Bun, WebSocket only). Build context: the repository root.
#   docker build -f server/Dockerfile -t grid-relay .
#   docker run -p 8787:8787 -e PORT=8787 grid-relay
# On Render (render.yaml) the platform sets PORT and terminates TLS, so clients use wss://.
FROM oven/bun:1.2-alpine
WORKDIR /app
# The relay needs only its own files and the shared protocol (types are erased at runtime).
COPY server/index.ts server/rooms.ts ./server/
COPY src/net/protocol.ts ./src/net/protocol.ts
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
USER bun
CMD ["bun", "server/index.ts"]
