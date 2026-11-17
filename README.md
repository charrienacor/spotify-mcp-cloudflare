# Spotify MCP on Cloudflare Workers

A personal **Spotify MCP server** — lets any MCP-compatible AI client (Claude, Cursor, custom agents, …) control your Spotify: create playlists, search, queue, and control playback, guarded by a full OAuth 2.1 login flow.

Live at: `https://spotify-mcp.charrienacor.workers.dev/mcp`

## Architecture

Two Workers, per [Cloudflare's current MCP authorization pattern](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/):

```
                       ┌────────────────────────────────┐
   MCP client          │        spotify-mcp             │
 (Claude, Cursor,  ───▶│  /mcp (OAuth resource server)  │───▶ Spotify Web API
  custom agents)       │  15 Spotify tools              │    api.spotify.com
                       └───────────┬────────────────────┘
                                   │ service binding: validateToken()
                       ┌───────────▼────────────────────┐
                       │        spotify-auth            │
                       │  /authorize (password-gated)   │
                       └───────────┬────────────────────┘
                                   │
                          OAUTH_KV (grants & tokens)

  Spotify refresh token ──▶ SPOTIFY_TOKENS KV (auto-refreshed hourly)
```

| Folder | Worker | Role |
|---|---|---|
| `spotify-auth/` | `spotify-auth.charrienacor.workers.dev` | Authorization server — sign-in page (gated by `ACCESS_PASSWORD`), issues MCP access tokens |
| `spotify-mcp/` | `spotify-mcp.charrienacor.workers.dev` | Resource server — the MCP endpoint, Spotify tools, Spotify account connect flow |

## Tools

| Tool | Description |
|---|---|
| `whoami` | Returns the signed-in MCP user (tests the OAuth chain) |
| `spotify_status` | Whether a Spotify account is connected, and as whom |
| `spotify_search` | Search tracks / artists / albums / playlists |
| `spotify_create_playlist` | Create a playlist, returns its ID |
| `spotify_get_playlists` | List your playlists |
| `spotify_add_tracks` | Add up to 100 track URIs to a playlist |
| `spotify_get_devices` | List active devices (for playback tools) |
| `spotify_now_playing` | Current or last-played track |
| `spotify_play` | Start playback (playlist/album context or track URIs) — Premium |
| `spotify_pause` | Pause playback — Premium |
| `spotify_skip` | Skip to next track, verified by read-back — Premium |
| `spotify_queue` | Add a track to the queue — Premium |
| `spotify_volume` | Get current volume, or set an exact level 0-100 — Premium to set |
| `spotify_volume_up` | Volume up by a step (default 10) — Premium |
| `spotify_volume_down` | Volume down by a step (default 10) — Premium |

*Playback tools require Spotify Premium and an active device; playlist tools work on free accounts.*

## Setup from scratch

### 1. Spotify Developer app

1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app**
2. Redirect URI: `https://<your-worker>.workers.dev/spotify/callback`
3. Enable **Web API** → save → copy the **Client ID** and **Client Secret**

### 2. KV namespaces

```bash
npx wrangler kv namespace create SPOTIFY_TOKENS   # → put id in spotify-mcp/wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV         # → put id in spotify-auth/wrangler.jsonc
```

### 3. Secrets (never committed)

```bash
cd spotify-mcp
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET

cd ../spotify-auth
npx wrangler secret put ACCESS_PASSWORD   # gates your sign-in page
```

### 4. Deploy (auth first — the MCP server binds to it)

```bash
cd spotify-auth && npm install && npm run deploy
cd ../spotify-mcp && npm install && npm run deploy
```

Update the `vars` in both `wrangler.jsonc` files to match your Worker names/subdomain.

## Connecting a client

Point any MCP client at:

```json
{
  "mcpServers": {
    "spotify": {
      "type": "http",
      "url": "https://<your-worker>.workers.dev/mcp"
    }
  }
}
```

One-time per client: the client gets a 401 → browser popup opens → enter `ACCESS_PASSWORD` → Authorize. Then connect your Spotify account once at `https://<your-worker>.workers.dev/spotify/login`.

Quick test without any client:

```bash
npx @modelcontextprotocol/inspector
# Streamable HTTP → https://<your-worker>.workers.dev/mcp → Connect
```

## Operations

| Task | Command |
|---|---|
| Redeploy after code changes | `npm run deploy` in the changed project |
| Live logs | `npx wrangler tail` in the project folder |
| Reconnect Spotify (after revoking access) | visit `/spotify/login` again |
| Rotate the sign-in password | `npx wrangler secret put ACCESS_PASSWORD` in `spotify-auth` |
| Revoke all access | delete tokens: `npx wrangler kv key delete --binding=SPOTIFY_TOKENS tokens` |

## Adding a new tool

Open `spotify-mcp/src/spotify.ts`, find the [Spotify Web API reference](https://developer.spotify.com/documentation/web-api/reference), and add:

```ts
server.registerTool(
  "spotify_<name>",
  {
    description: "…",
    inputSchema: { /* zod fields */ },
  },
  async (args) => {
    const data = await spotifyApi("/v1/endpoint…");
    return text(JSON.stringify(data, null, 2));
  }
);
```

Then `npm run deploy` in `spotify-mcp/`. The client picks up the new tool on its next connect.

## Security notes

- Secrets are stored with `wrangler secret put` — they never enter git.
- The sign-in page requires `ACCESS_PASSWORD`; without it, no MCP client can obtain a token.
- Tokens issued are bound to the exact `MCP_SERVER_URL` and validated over a Cloudflare service binding (never leaves Cloudflare's network).
