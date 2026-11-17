import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { env } from "cloudflare:workers";

const TOKENS_KEY = "tokens";

interface SpotifyTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

function loginUrl(): string {
  const origin = new URL(env.MCP_SERVER_URL).origin;
  return `${origin}/spotify/login`;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

export async function getAccessToken(): Promise<string> {
  const raw = await env.SPOTIFY_TOKENS.get(TOKENS_KEY);
  if (!raw) {
    throw new Error(
      `Spotify account not connected. Open ${loginUrl()} in a browser and authorize your account, then retry.`
    );
  }

  const tokens = JSON.parse(raw) as SpotifyTokens;
  if (!tokens.refresh_token) {
    throw new Error(
      `Stored Spotify tokens are incomplete. Reconnect at ${loginUrl()}.`
    );
  }

  // Return the cached access token while it is still fresh.
  if (
    tokens.access_token &&
    tokens.expires_at &&
    tokens.expires_at > Date.now() + 60_000
  ) {
    return tokens.access_token;
  }

  // Refresh it.
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(
        `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
      )}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Spotify token refresh failed (${res.status}). Reconnect at ${loginUrl()}. Details: ${detail}`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const updated: SpotifyTokens = {
    refresh_token: data.refresh_token || tokens.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await env.SPOTIFY_TOKENS.put(TOKENS_KEY, JSON.stringify(updated));
  return updated.access_token as string;
}

async function spotifyApi<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }

  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  });

  const responseText = await res.text();
  let data: unknown = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      // Playback-control endpoints (play/pause/skip/queue) answer success with
      // an EMPTY 204 — and Spotify's edge occasionally attaches a malformed
      // body to one (measured: POST /me/player/next arrived 2xx with garbage
      // that made JSON.parse throw "Unexpected token 'x', "xR-g8LRUeC"...").
      // The status is the truth: a 2xx means the command executed, so treat
      // any unreadable body on a 2xx as success. A non-2xx with an unreadable
      // body fails with the status and a body prefix — never a bare
      // SyntaxError the caller cannot interpret.
      if (res.ok) {
        console.log(`spotifyApi: ${res.status} ${path} with non-JSON body: ${responseText.slice(0, 80)}`);
        data = {};
      } else {
        throw new Error(
          `Spotify API error (${res.status}): unreadable response body: ${responseText.slice(0, 120)}`
        );
      }
    }
  }

  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ??
      responseText;
    throw new Error(`Spotify API error (${res.status}): ${message}`);
  }

  return data as T;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerSpotifyTools(server: McpServer) {
  server.registerTool(
    "spotify_status",
    {
      description:
        "Check whether a Spotify account is connected and which tools are available.",
      inputSchema: {},
    },
    async () => {
      try {
        const raw = await env.SPOTIFY_TOKENS.get(TOKENS_KEY);
        if (!raw) return text("Spotify is NOT connected.");
        const me = await spotifyApi<{ display_name: string }>("/me");
        return text(
          `Spotify connected as "${me.display_name}". Playlist and playback tools are ready.`
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_search",
    {
      description:
        "Search Spotify for tracks, artists, albums, or playlists. Use track URIs from results with other tools.",
      inputSchema: {
        query: z.string().describe("Search text, e.g. a song or artist name"),
        type: z
          .enum(["track", "artist", "album", "playlist"])
          .default("track")
          .describe("What to search for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results (max 50)"),
      },
    },
    async ({ query, type, limit }) => {
      try {
        const data = await spotifyApi<{
          tracks?: { items: Array<{ name: string; uri: string; artists: Array<{ name: string }>; album?: { name: string } }> };
          artists?: { items: Array<{ name: string; uri: string }> };
          albums?: { items: Array<{ name: string; uri: string; artists: Array<{ name: string }> }> };
          playlists?: { items: Array<{ name: string; uri: string; owner?: { display_name?: string } }> };
        }>(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);

        const lines: string[] = [];
        if (type === "track") {
          for (const t of data.tracks?.items ?? []) {
            lines.push(
              `${t.name} — ${t.artists.map((a) => a.name).join(", ")}${
                t.album ? ` (${t.album.name})` : ""
              } [${t.uri}]`
            );
          }
        } else if (type === "artist") {
          for (const a of data.artists?.items ?? []) lines.push(`${a.name} [${a.uri}]`);
        } else if (type === "album") {
          for (const al of data.albums?.items ?? []) {
            lines.push(
              `${al.name} — ${al.artists.map((a) => a.name).join(", ")} [${al.uri}]`
            );
          }
        } else {
          for (const p of data.playlists?.items ?? []) {
            lines.push(`${p.name} (by ${p.owner?.display_name ?? "unknown"}) [${p.uri}]`);
          }
        }
        return text(lines.length ? lines.join("\n") : "No results found.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_create_playlist",
    {
      description:
        "Create a new playlist in the connected Spotify account and return its ID.",
      inputSchema: {
        name: z.string().describe("Playlist name"),
        description: z.string().optional().describe("Playlist description"),
        is_public: z
          .boolean()
          .default(true)
          .describe("Whether the playlist is public"),
      },
    },
    async ({ name, description, is_public }) => {
      try {
        const playlist = await spotifyApi<{
          id: string;
          name: string;
          external_urls: { spotify: string };
        }>("/me/playlists", {
          method: "POST",
          json: { name, description: description ?? "", public: is_public },
        });
        return text(
          `Created playlist "${playlist.name}" (id: ${playlist.id}). URL: ${playlist.external_urls.spotify}`
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_get_playlists",
    {
      description: "List the playlists in the connected Spotify account.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe("Max playlists to return"),
      },
    },
    async ({ limit }) => {
      try {
        const data = await spotifyApi<{
          items: Array<{
            name: string;
            id: string;
            uri: string;
            tracks: { total: number };
          }>;
        }>(`/me/playlists?limit=${limit}`);
        const lines = data.items.map(
          (p) => `${p.name} — ${p.tracks.total} tracks (id: ${p.id})`
        );
        return text(lines.length ? lines.join("\n") : "No playlists found.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_add_tracks",
    {
      description:
        "Add tracks (by URI, e.g. spotify:track:...) to a playlist. Up to 100 per call.",
      inputSchema: {
        playlist_id: z.string().describe("Playlist ID from spotify_create_playlist or spotify_get_playlists"),
        track_uris: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Track URIs to add, e.g. ['spotify:track:4uLU6hMCjMI75M1A2tKUQC']"),
      },
    },
    async ({ playlist_id, track_uris }) => {
      try {
        await spotifyApi(`/playlists/${playlist_id}/tracks`, {
          method: "POST",
          json: { uris: track_uris },
        });
        return text(`Added ${track_uris.length} track(s) to playlist ${playlist_id}.`);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_get_devices",
    {
      description:
        "List active Spotify devices. Use a device_id with playback tools (Premium required for playback).",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await spotifyApi<{
          devices: Array<{ id: string; name: string; type: string; is_active: boolean }>;
        }>("/me/player/devices");
        const lines = data.devices.map(
          (d) =>
            `${d.name} (${d.type})${d.is_active ? " — ACTIVE" : ""} [device_id: ${d.id}]`
        );
        return text(lines.length ? lines.join("\n") : "No active devices found. Open Spotify on a device first.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_now_playing",
    {
      description: "Get the track currently playing (or most recently played).",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
          headers: { Authorization: `Bearer ${await getAccessToken()}` },
        });
        if (res.status === 204) {
          return text("Nothing is currently playing.");
        }
        const data = (await res.json()) as {
          is_playing: boolean;
          item?: { name: string; artists: Array<{ name: string }>; album?: { name: string } };
          device?: { name: string };
        };
        if (!data.item) return text("Nothing is currently playing.");
        const track = data.item;
        return text(
          `${data.is_playing ? "▶️ Playing" : "⏸ Paused"}: ${track.name} — ${track.artists
            .map((a) => a.name)
            .join(", ")}${track.album ? ` (${track.album.name})` : ""}${
            data.device ? ` on ${data.device.name}` : ""
          }`
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_play",
    {
      description:
        "Start playback. Optionally target a device and a playlist/album URI or track URIs. Spotify Premium required.",
      inputSchema: {
        device_id: z.string().optional().describe("Device to play on (from spotify_get_devices)"),
        context_uri: z
          .string()
          .optional()
          .describe("URI of a playlist or album to play, e.g. spotify:playlist:..."),
        track_uris: z.array(z.string()).optional().describe("Track URIs to play instead of a context"),
      },
    },
    async ({ device_id, context_uri, track_uris }) => {
      try {
        const params = device_id ? `?device_id=${encodeURIComponent(device_id)}` : "";
        const json: Record<string, unknown> = {};
        if (context_uri) json.context_uri = context_uri;
        if (track_uris) json.uris = track_uris;
        await spotifyApi(`/me/player/play${params}`, {
          method: "PUT",
          json: Object.keys(json).length ? json : undefined,
        });
        return text("Playback started.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_pause",
    {
      description: "Pause playback. Spotify Premium required.",
      inputSchema: {
        device_id: z.string().optional().describe("Device to pause (defaults to active device)"),
      },
    },
    async ({ device_id }) => {
      try {
        const params = device_id ? `?device_id=${encodeURIComponent(device_id)}` : "";
        await spotifyApi(`/me/player/pause${params}`, { method: "PUT" });
        return text("Playback paused.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_skip",
    {
      description: "Skip to the next track. Spotify Premium required.",
      inputSchema: {
        device_id: z.string().optional().describe("Device to skip on (defaults to active device)"),
      },
    },
    async ({ device_id }) => {
      try {
        const params = device_id ? `?device_id=${encodeURIComponent(device_id)}` : "";
        await spotifyApi(`/me/player/next${params}`, { method: "POST" });
        return text("Skipped to next track.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_queue",
    {
      description: "Add a track to the playback queue. Spotify Premium required.",
      inputSchema: {
        track_uri: z.string().describe("Track URI to queue, e.g. spotify:track:4uLU6hMCjMI75M1A2tKUQC"),
        device_id: z.string().optional().describe("Device to queue on (defaults to active device)"),
      },
    },
    async ({ track_uri, device_id }) => {
      try {
        const params = new URLSearchParams({ uri: track_uri });
        if (device_id) params.set("device_id", device_id);
        await spotifyApi(`/me/player/queue?${params.toString()}`, { method: "POST" });
        return text("Track added to queue.");
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Volume (Premium; works on the active Spotify Connect device)
  // -------------------------------------------------------------------------

  async function getCurrentVolumePercent(): Promise<number | null> {
    const data = await spotifyApi<{ device?: { volume_percent?: number } }>("/me/player");
    const volume = data.device?.volume_percent;
    return typeof volume === "number" ? volume : null;
  }

  async function setVolumePercent(percent: number, deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ volume_percent: String(Math.round(percent)) });
    if (deviceId) params.set("device_id", deviceId);
    await spotifyApi(`/me/player/volume?${params.toString()}`, { method: "PUT" });
  }

  server.registerTool(
    "spotify_volume",
    {
      description:
        "Get the current playback volume (0-100), or set it to an exact level. Spotify Premium required to set.",
      inputSchema: {
        level: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Volume 0-100. Omit to just read the current volume."),
        device_id: z.string().optional().describe("Device to control (defaults to active device)"),
      },
    },
    async ({ level, device_id }) => {
      try {
        if (level === undefined) {
          const current = await getCurrentVolumePercent();
          return text(
            current === null
              ? "No active playback, so the current volume is unknown."
              : `Current volume: ${current}%.`
          );
        }
        await setVolumePercent(level, device_id);
        return text(`Volume set to ${level}%.`);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_volume_up",
    {
      description:
        "Turn the volume up by a step (default 10). Reads the current level first and clamps at 100. Spotify Premium required.",
      inputSchema: {
        step: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("How much to increase the volume (percentage points)"),
        device_id: z.string().optional().describe("Device to control (defaults to active device)"),
      },
    },
    async ({ step, device_id }) => {
      try {
        const current = await getCurrentVolumePercent();
        if (current === null) {
          return text(
            "No active playback, so the current volume is unknown. Use spotify_volume with an explicit level instead."
          );
        }
        const next = Math.min(100, current + step);
        if (next === current) return text(`Volume already at maximum (${current}%).`);
        await setVolumePercent(next, device_id);
        return text(`Volume up: ${current}% → ${next}%.`);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "spotify_volume_down",
    {
      description:
        "Turn the volume down by a step (default 10). Reads the current level first and clamps at 0. Spotify Premium required.",
      inputSchema: {
        step: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("How much to decrease the volume (percentage points)"),
        device_id: z.string().optional().describe("Device to control (defaults to active device)"),
      },
    },
    async ({ step, device_id }) => {
      try {
        const current = await getCurrentVolumePercent();
        if (current === null) {
          return text(
            "No active playback, so the current volume is unknown. Use spotify_volume with an explicit level instead."
          );
        }
        const next = Math.max(0, current - step);
        if (next === current) return text(`Volume already at minimum (${current}%).`);
        await setVolumePercent(next, device_id);
        return text(`Volume down: ${current}% → ${next}%.`);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
