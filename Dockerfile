FROM node:18-slim AS builder
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:18-slim
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /usr/src/app/dist ./dist

RUN mkdir -p /usr/src/app/logs

CMD sh -c "node dist/index.js 2>&1 | tee /usr/src/app/logs/job.log"