# Replay API trust

`riotgames.pem` is Riot's published Game Client root certificate, retrieved from
[Riot's certificate endpoint](https://static.developer.riotgames.com/docs/lol/riotgames.pem).
It is used only by the dedicated loopback Replay API HTTPS client. The application
does not disable system-wide TLS verification.

Source: [Game Client API documentation](https://developer.riotgames.com/docs/lol#game-client-api_root-certificatessl-errors).
