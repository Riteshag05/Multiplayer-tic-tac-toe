FROM heroiclabs/nakama:3.25.0

COPY ./nakama/modules /nakama/data/modules

CMD ["sh", "-ec", "\
/nakama/nakama migrate up --database.address \"$NAKAMA_DATABASE_ADDRESS\" && \
exec /nakama/nakama \
  --name nakama1 \
  --database.address \"$NAKAMA_DATABASE_ADDRESS\" \
  --logger.level INFO \
  --session.token_expiry_sec 7200 \
"]