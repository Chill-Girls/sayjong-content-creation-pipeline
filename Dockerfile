# --- 1. Builder 스테이지: Node.js 앱 빌드 ---
FROM node:18-bookworm AS builder
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

# .dockerignore에 scripts/가 포함되어 있지 않은지 확인하세요.
COPY . .
RUN npm run build

# --- 2. Final 스테이지: 프로덕션 환경 ---
FROM node:18-bookworm
WORKDIR /usr/src/app

# --- 2a. Python + FFmpeg 환경 설치 (tts-demo Dockerfile에서 가져옴) ---
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# --- 2b. Python 가상 환경 설정 및 종속성 설치 ---
RUN python3.11 -m venv /opt/venv
RUN /opt/venv/bin/pip install --no-cache-dir stable-ts

# --- 2c. Node.js 프로덕션 종속성 설치 ---
COPY package*.json ./
RUN npm install --omit=dev

# --- 2d. 빌드된 앱 코드 복사 ---
COPY --from=builder /usr/src/app/dist ./dist

# --- 2e. Python 스크립트 복사 ---
# 로컬의 ./scripts/process_audio.py 파일을 이미지의 /usr/src/app/scripts/로 복사
COPY ./scripts/process_audio.py /usr/src/app/scripts/process_audio.py

# --- 2f. 로그 디렉토리 생성 ---
RUN mkdir -p /usr/src/app/logs

# --- 2g. 최종 실행 명령어 ---
ENV GCP_SERVICE_KEY_PATH=/usr/src/app/gcp-service-key.json
ENV PYTHON_EXECUTABLE=/opt/venv/bin/python
ENV PYTHON_SCRIPT_PATH=/usr/src/app/scripts/process_audio.py

CMD sh -c "node dist/index.js 2>&1 | tee /usr/src/app/logs/job.log"