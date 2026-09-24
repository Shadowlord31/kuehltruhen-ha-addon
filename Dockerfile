ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY app/package.json app/package-lock.json* ./
# Build-Tools nur temporär, falls better-sqlite3 kein Prebuild für musl/Arch findet
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev \
    && apk del .build-deps

COPY app/ ./

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
