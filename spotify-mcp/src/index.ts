import {
  OAuthResourceServer,
  type AuthorizationServerBinding,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { registerSpotifyTools } from "./spotify";
import { handleSpotifyOAuth } from "./spotify-oauth";

type AuthProps = { userId: string };
type AuthServer = AuthorizationServerBinding<AuthProps>;

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1d24; padding: 32px; border-radius: 12px; max-width: 420px; width: 90%; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #9aa0aa; font-size: 13px; line-height: 1.6; margin: 0 0 14px; }
  a { color: #1db954; }
</style>
</head>
<body><div class="card"><h1>${title}</h1>${body}</div></body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    }
  );
}

function createServer() {
  const server = new McpServer({ name: "spotify-mcp", version: "1.0.0" });
  const props = getMcpAuthContext()?.props as AuthProps | undefined;

  // Simple test tool proving the OAuth layer works end to end.
  server.registerTool(
    "whoami",
    { description: "Return the signed-in user of this MCP server." },
    async () => ({
      content: [
        {
          type: "text",
          text: `Signed in as: ${props?.userId ?? "unknown"}`,
        },
      ],
    })
  );

  registerSpotifyTools(server);
  return server;
}

const mcpHandler = createMcpHandler(createServer);

const resourceServer = new OAuthResourceServer<Env, AuthProps>({
  resourceMetadata: {
    resource: env.MCP_SERVER_URL, // tokens for any other resource are rejected
    authorization_servers: [env.AUTH_SERVER_URL],
  },
  requiredScopes: ["mcp:read"],
  // The generated binding type is a plain Fetcher; it gains validateToken()
  // because the target Worker exports it.
  validateToken: (env) =>
    (env.AUTH_SERVER as unknown as AuthServer).validateToken,
  handler: {
    fetch(request, env, ctx) {
      return mcpHandler(request, env, ctx);
    },
  },
});

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // Spotify account connect flow (no MCP auth required).
    if (pathname === "/spotify/login" || pathname === "/spotify/callback") {
      return handleSpotifyOAuth(request, env);
    }

    // OAuth discovery metadata for MCP clients.
    if (pathname.startsWith("/.well-known/")) {
      return resourceServer.fetch(request, env, ctx);
    }

    // The protected MCP endpoint.
    if (pathname === "/mcp") {
      return resourceServer.fetch(request, env, ctx);
    }

    if (pathname === "/") {
      return page(
        "Spotify MCP Server",
        `<p>This is a personal Spotify MCP server. Point your MCP client at <code>/mcp</code> and it will ask you to sign in.</p>
         <p>First time? Connect your Spotify account: <a href="/spotify/login">Connect Spotify</a></p>`
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
