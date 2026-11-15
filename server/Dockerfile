# The Grid multiplayer relay (Bun, WebSocket only). Build context: the repository root.
#   docker build -f server/Dockerfile -t grid-relay .
#   docker run -p 8787:8787 -e PORT=8787 grid-relay
# On Render (render.yaml) the platform sets PORT and terminates TLS, so clients use wss://.
FROM oven/bun:1.2-alpine
WORKDIR /app
# The relay needs only its own files, the shared protocol, the Bits' evolution core it runs the
# world with, and the living world's core (types are erased at runtime).
COPY server/index.ts server/rooms.ts server/world.ts server/living.ts ./server/
COPY src/net/protocol.ts ./src/net/protocol.ts
COPY src/sim/evolution.ts ./src/sim/evolution.ts
COPY src/people/genome.ts src/people/bitStyle.ts ./src/people/
# The living world (AGENTS.md §21): its core and the planet as it sees it (no world generator).
COPY src/living/state.ts src/living/advance.ts src/living/shippedMap.ts src/living/baseMap.json ./src/living/
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
USER bun
CMD ["bun", "server/index.ts"]
