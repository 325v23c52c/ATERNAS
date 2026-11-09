FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json requirements.txt ./
RUN npm install --omit=dev && pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY afk.js bot.py ./
CMD ["python3", "bot.py"]
