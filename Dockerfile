FROM heroiclabs/nakama:3.25.0

COPY ./nakama/modules /nakama/data/modules

ENV NAKAMA_DATABASE_ADDRESS=${NAKAMA_DATABASE_ADDRESS}

CMD ["/bin/sh", "-ec", "\
/nakama/nakama migrate up --database.address \"$NAKAMA_DATABASE_ADDRESS\" && \
exec /nakama/nakama \
  --database.address \"$NAKAMA_DATABASE_ADDRESS\" \
  --name nakama1 \
  --logger.level INFO \
"]