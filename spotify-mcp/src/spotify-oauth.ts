import { env } from "cloudflare:workers";

// Scopes requested from Spotify when the owner connects their account.
export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-email",
  "playlist-read-private",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-read",
  "user-top-read",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
].join(" ");

interface SpotifyTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Spotify MCP</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1d24; padding: 32px; border-radius: 12px; max-width: 420px; text-align: center; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    }
  );
}

function spotifyTokenHeaders(): HeadersInit {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function handleSpotifyOAuth(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/spotify/callback`;

  // Step 1: send the owner to Spotify to authorize the app.
  if (url.pathname === "/spotify/login") {
    const state = crypto.randomUUID();
    await env.SPOTIFY_TOKENS.put(`state:${state}`, "1", {
      expirationTtl: 600,
    });
    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", env.SPOTIFY_CLIENT_ID);
    authUrl.searchParams.set("scope", SPOTIFY_SCOPES);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    return Response.redirect(authUrl.toString(), 302);
  }

  // Step 2: Spotify redirects back — exchange the code for tokens.
  if (url.pathname === "/spotify/callback") {
    const error = url.searchParams.get("error");
    if (error) {
      return html(`<h2>❌ Authorization failed</h2><p>${error}</p>`, 400);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return html("<h2>❌ Missing code or state</h2>", 400);
    }

    // CSRF check: the state must be one we issued.
    const stateKey = `state:${state}`;
    const issued = await env.SPOTIFY_TOKENS.get(stateKey);
    if (!issued) {
      return html(
        "<h2>❌ Invalid or expired state</h2><p>Start again at /spotify/login</p>",
        400
      );
    }
    await env.SPOTIFY_TOKENS.delete(stateKey);

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: spotifyTokenHeaders(),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      return html(
        `<h2>❌ Token exchange failed</h2><pre>${detail}</pre>`,
        400
      );
    }

    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const tokens: SpotifyTokens = {
      // Spotify returns a refresh token on the initial authorization.
      refresh_token: data.refresh_token ?? "",
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await env.SPOTIFY_TOKENS.put("tokens", JSON.stringify(tokens));

    // Greet the owner with their Spotify display name.
    let displayName = "";
    try {
      const me = (await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${data.access_token}` },
      }).then((r) => r.json())) as { display_name?: string };
      displayName = me.display_name ?? "";
    } catch {
      // Non-fatal.
    }

    return html(
      `<h2>✅ Spotify connected${displayName ? ` as ${displayName}` : ""}</h2>
       <p>You can close this window and start using your Spotify MCP tools.</p>`
    );
  }

  return new Response("Not found", { status: 404 });
}
