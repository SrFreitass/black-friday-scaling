FROM oven/bun:latest

WORKDIR /app

COPY package.json ./
COPY bun.lock ./
COPY src ./src

RUN bun install --frozen-lockfile

CMD ["bun", "run", "start"]
