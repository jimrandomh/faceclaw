# Hermes agent as the assistant

The "Hermes agent" assistant model sends what you say to a
[Hermes Agent](https://github.com/NousResearch/hermes-agent) gateway through its
OpenAI-compatible API server and streams the answer back to the glasses. Hermes
runs its own tools and keeps the conversation: each Faceclaw assistant
conversation maps to one Hermes session (`X-Hermes-Session-Id`), and only the
latest message is sent. Faceclaw's own glasses tools are not offered to Hermes.

## Enable the API server in Hermes

In the Hermes config, enable the `api_server` platform and bind it where the
phone can reach it, then set a key in Hermes's `.env` and restart the gateway:

    hermes config set platforms.api_server.enabled true
    hermes config set platforms.api_server.extra.host <address the phone can reach>
    hermes config set platforms.api_server.extra.port 8642
    echo "API_SERVER_KEY=$(openssl rand -hex 24)" >> ~/.hermes/.env

Check it with `curl -H "Authorization: Bearer <key>" http://<host>:8642/v1/models`.

## Settings (Settings > Assistant)

- **Assistant model**: Hermes agent. Disabled until the URL is set.
- **Hermes URL**: e.g. `http://host:8642/v1` (a bare host gets `/v1` added).
- **Hermes key**: the `API_SERVER_KEY` value.

On iOS, App Transport Security blocks plain `http://` to IP addresses unless
`App_Resources/iOS/Info.plist` has an `NSExceptionDomains` entry for that host
(`NSExceptionAllowsInsecureHTTPLoads`); otherwise serve the API over https, for
example with `tailscale serve`.

Actions that Hermes holds for approval (`approvals.mode manual`) cannot be
approved from the glasses; approve them from Hermes itself.
