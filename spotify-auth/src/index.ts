import {
  AuthorizationError,
  OAuthAuthorizationServer,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint, env } from "cloudflare:workers";

// Everything this server can grant.
const SCOPES = ["mcp:read", "mcp:write", "offline_access"];

const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: env.ISSUER, // this Worker's URL
  resources: [env.MCP_SERVER_URL], // the MCP server it issues tokens for
  scopesSupported: SCOPES,
  clientIdMetadataDocumentEnabled: true,
  // Dynamic Client Registration for older MCP clients.
  clientRegistrationEndpoint: "/oauth/register",
  // Sliding grant lifetime: every successful refresh moves the expiry
  // forward, so the owner's grant lives as long as its refresh token keeps
  // being used (the lava agent refreshes on every session start). After 90
  // days of total silence the grant still expires and a re-login is needed.
  refreshTokenIdleTTL: 90 * 24 * 60 * 60,
});

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1d24; padding: 32px; border-radius: 12px; max-width: 380px; width: 90%; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #9aa0aa; font-size: 13px; line-height: 1.5; margin: 0 0 20px; }
  input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #2c313a; background: #0f1115; color: #e6e6e6; font-size: 14px; margin-bottom: 14px; }
  button { width: 100%; padding: 10px 12px; border-radius: 8px; border: none; background: #1db954; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  .error { color: #ff6b6b; font-size: 13px; margin: 0 0 12px; }
</style>
</head>
<body><div class="card"><h1>${title}</h1>${body}</div></body>
</html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    }
  );
}

function passwordForm(action: string, errorMessage: string): Response {
  const body = `
    <p>Enter your access password to connect this client to your Spotify MCP server.</p>
    ${errorMessage ? `<p class="error">${errorMessage}</p>` : ""}
    <form method="POST" action="${action}">
      <input type="password" name="password" placeholder="Access password" autofocus required />
      <button type="submit">Authorize</button>
    </form>`;
  return page("Spotify MCP — Sign in", body, errorMessage ? 401 : 200);
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const action = `${url.pathname}${url.search}`;

  if (request.method === "GET") {
    return passwordForm(action, "");
  }

  // POST — verify the access password, then complete authorization.
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!env.ACCESS_PASSWORD || password !== env.ACCESS_PASSWORD) {
    return passwordForm(action, "Incorrect access password. Try again.");
  }

  const oauth = authorizationServer.getOAuthApi(env);
  let authRequest: AuthRequest;
  try {
    // Validates the client, redirect URI, resource, and PKCE.
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return new Response(error.description ?? "Invalid authorization request", {
      status: 400,
    });
  }

  // Single-user server: anyone who knows the access password is the owner.
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: "owner",
    metadata: {},
    scope: authRequest.scope.filter((scope) => SCOPES.includes(scope)),
    props: { userId: "owner" },
  });
  return Response.redirect(redirectTo, 302);
}

export default class AuthServer extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/authorize") {
      return handleAuthorize(request, this.env);
    }

    if (pathname === "/") {
      return page(
        "Spotify MCP — Authorization server",
        "<p>This is the OAuth authorization server for your Spotify MCP server. MCP clients are redirected here to sign in.</p>"
      );
    }

    return authorizationServer.fetch(request, this.env, this.ctx);
  }

  // MCP server calls this over its Service Binding.
  validateToken(resource: string, token: string) {
    return authorizationServer.validateToken(resource, token, this.env);
  }
}
