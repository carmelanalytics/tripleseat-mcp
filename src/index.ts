/**
 * TripleSeat MCP Server — Vercel Serverless Edition
 *
 * Handles JSON-RPC directly instead of using the SDK transport.
 * Every request is self-contained — no sessions needed.
 * OAuth 2.1 Authorization Code + PKCE for MCP connector auth.
 */

import express from "express";
import cookieParser from "cookie-parser";
import {
  hasCredentials,
  hasRefreshToken,
  getAuthorizeUrl,
  exchangeCodeForTokens,
  storeTokens,
} from "./auth.js";
import { tripleseatGet, tripleseatPost, tripleseatPut } from "./tripleseat.js";
import { oauthTokenAuth } from "./middleware.js";
import { adminRouter } from "./admin/routes.js";
import { logToolCall } from "./usage.js";
import { migrate } from "./db.js";
import { seedDefaultRoles } from "./roles.js";
import { seedAdminUser, changePassword } from "./users.js";
import { authenticateUser } from "./users.js";
import {
  getMetadata,
  registerClient,
  getClient,
  createAuthCode,
  exchangeCode,
  refreshAccessToken,
  validateToken,
  renderLoginPage,
  OAuthError,
} from "./oauth.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Run migrations on cold start
let migrated = false;
async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    await migrate();
    const { created } = await seedDefaultRoles();
    if (created.length > 0) console.log("[Init] Seeded roles:", created.join(", "));

    // Seed admin user from env vars if no admin exists yet
    const { query: dbQuery } = await import("./db.js");
    const adminRole = await dbQuery<{ id: string }>(
      `SELECT id FROM mcp_roles WHERE name = 'admin' LIMIT 1`
    );
    if (adminRole.length > 0) {
      const result = await seedAdminUser(adminRole[0].id);
      if (result.created) console.log("[Init] Seeded admin user:", result.email);
    }
  } catch (err: any) {
    console.error("[Init] Migration error:", err.message);
    migrated = false;
  }
}

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PATCH");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID");
  res.header("Access-Control-Expose-Headers", "Content-Type, Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Ensure DB is migrated before any route
app.use(async (_req, _res, next) => {
  await ensureMigrated();
  next();
});

// Health check
app.get("/", (_req, res) => {
  try {
    const status = !hasCredentials()
      ? "missing_credentials"
      : !hasRefreshToken()
      ? "needs_oauth_setup"
      : "ready";
    res.json({
      name: "tripleseat-mcp",
      version: "3.0.0",
      status,
      transport: "streamable-http",
      endpoint: "/mcp",
      admin: "/admin/login",
      auth: "oauth2-authorization-code",
       env_present: {
        TRIPLESEAT_CLIENT_ID: !!process.env.TRIPLESEAT_CLIENT_ID,
        TRIPLESEAT_CLIENT_SECRET: !!process.env.TRIPLESEAT_CLIENT_SECRET,
        DATABASE_URL: !!process.env.DATABASE_URL,
        ADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
        ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
      },
      setup: status === "needs_oauth_setup" ? "/auth/login" : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ── OAuth 2.1 Endpoints (MCP protocol auth) ──

// Discovery metadata
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "tripleseat-mcp.vercel.app";
  const issuer = protocol + "://" + host;
  res.json(getMetadata(issuer));
});

// Dynamic client registration (RFC 7591)
app.post("/oauth/register", async (req, res) => {
  try {
    const { client_name, redirect_uris } = req.body;
    const client = await registerClient(client_name, redirect_uris);
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
    });
  } catch (err: any) {
    console.error("[OAuth Register Error]", err.message);
    res.status(500).json({ error: "server_error", error_description: err.message });
  }
});

// Authorization endpoint — GET shows login page
app.get("/oauth/authorize", (req, res) => {
  const {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    response_type,
  } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (!client_id || !redirect_uri || !code_challenge || !state) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "client_id, redirect_uri, code_challenge, and state are required",
    });
    return;
  }

  res.type("html").send(
    renderLoginPage({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || "S256",
      state,
    })
  );
});

// Authorization endpoint — POST processes login
app.post("/oauth/authorize", async (req, res) => {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, email, password } =
    req.body;

  if (!client_id || !redirect_uri || !code_challenge || !state || !email || !password) {
    res.type("html").send(
      renderLoginPage({
        clientId: client_id || "",
        redirectUri: redirect_uri || "",
        codeChallenge: code_challenge || "",
        codeChallengeMethod: code_challenge_method || "S256",
        state: state || "",
        error: "All fields are required.",
      })
    );
    return;
  }

  try {
    const user = await authenticateUser(email, password);

    if (!user) {
      res.type("html").send(
        renderLoginPage({
          clientId: client_id,
          redirectUri: redirect_uri,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method || "S256",
          state,
          error: "Invalid email or password.",
        })
      );
      return;
    }

    const code = await createAuthCode(
      user.id,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method || "S256"
    );

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", state);

    res.redirect(redirectUrl.toString());
  } catch (err: any) {
    console.error("[OAuth Authorize Error]", err.message);
    res.type("html").send(
      renderLoginPage({
        clientId: client_id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method || "S256",
        state,
        error: "An error occurred. Please try again.",
      })
    );
  }
});

// Token endpoint — exchange code or refresh
app.post("/oauth/token", async (req, res) => {
  try {
    const { grant_type } = req.body;

    if (grant_type === "authorization_code") {
      const { code, code_verifier, redirect_uri } = req.body;

      if (!code || !code_verifier || !redirect_uri) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "code, code_verifier, and redirect_uri are required",
        });
        return;
      }

      const tokens = await exchangeCode(code, code_verifier, redirect_uri);
      res.json(tokens);

    } else if (grant_type === "refresh_token") {
      const { refresh_token } = req.body;

      if (!refresh_token) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "refresh_token is required",
        });
        return;
      }

      const tokens = await refreshAccessToken(refresh_token);
      res.json(tokens);

    } else {
      res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "Supported: authorization_code, refresh_token",
      });
    }
  } catch (err: any) {
    if (err instanceof OAuthError) {
      res.status(400).json({ error: err.code, error_description: err.message });
    } else {
      console.error("[OAuth Token Error]", err.message);
      res.status(500).json({ error: "server_error", error_description: err.message });
    }
  }
});

// ── Admin Dashboard ──
app.use("/admin", adminRouter);

// ── Account: Change Password ──

function changePasswordPage(opts: { error?: string; success?: string } = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TripleSeat MCP - Change Password</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0a; --surface: #141414; --border: #262626;
      --text: #ededed; --text-secondary: #888888;
      --accent: #0070f3; --accent-hover: #0060d3;
      --success: #00c853; --success-subtle: rgba(0, 200, 83, 0.1);
      --danger: #ff4444; --danger-subtle: rgba(255, 68, 68, 0.1);
      --radius-sm: 6px;
      --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    body {
      background: var(--bg); color: var(--text); font-family: var(--font);
      font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 40px; width: 100%; max-width: 400px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    }
    .card h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .card .subtitle { color: var(--text-secondary); font-size: 13px; margin-bottom: 28px; }
    label { display: block; font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
    input[type="email"], input[type="password"] {
      width: 100%; padding: 10px 12px; background: var(--bg);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      color: var(--text); font-size: 14px; font-family: var(--font);
      outline: none; transition: border-color 0.15s; margin-bottom: 16px;
    }
    input:focus { border-color: var(--accent); }
    .error-msg {
      background: var(--danger-subtle); color: var(--danger);
      padding: 10px 12px; border-radius: var(--radius-sm);
      font-size: 13px; margin-bottom: 16px;
      border: 1px solid rgba(255, 68, 68, 0.2);
    }
    .success-msg {
      background: var(--success-subtle); color: var(--success);
      padding: 10px 12px; border-radius: var(--radius-sm);
      font-size: 13px; margin-bottom: 16px;
      border: 1px solid rgba(0, 200, 83, 0.2);
    }
    .btn {
      width: 100%; padding: 10px 16px; font-size: 13px; font-weight: 500;
      font-family: var(--font); border-radius: var(--radius-sm);
      border: 1px solid var(--accent); background: var(--accent);
      color: white; cursor: pointer; transition: background 0.15s; margin-top: 4px;
    }
    .btn:hover { background: var(--accent-hover); }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: var(--text-secondary); }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <h1>Change Password</h1>
      <p class="subtitle">Update your TripleSeat MCP password</p>
      ${opts.error ? `<div class="error-msg">${esc(opts.error)}</div>` : ""}
      ${opts.success ? `<div class="success-msg">${esc(opts.success)}</div>` : ""}
      <form method="POST" action="/account/change-password">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" placeholder="you@example.com" autofocus required>
        <label for="current_password">Current Password</label>
        <input type="password" id="current_password" name="current_password" placeholder="Enter current password" required>
        <label for="new_password">New Password</label>
        <input type="password" id="new_password" name="new_password" placeholder="Enter new password" required>
        <label for="confirm_password">Confirm New Password</label>
        <input type="password" id="confirm_password" name="confirm_password" placeholder="Confirm new password" required>
        <button type="submit" class="btn">Change Password</button>
      </form>
      <p class="footer">TripleSeat MCP &middot; Stormbreaker Digital</p>
    </div>
  </div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

app.get("/account/change-password", (_req, res) => {
  res.type("html").send(changePasswordPage());
});

app.post("/account/change-password", async (req, res) => {
  const { email, current_password, new_password, confirm_password } = req.body;

  if (!email || !current_password || !new_password || !confirm_password) {
    res.type("html").send(changePasswordPage({ error: "All fields are required." }));
    return;
  }

  if (new_password.length < 8) {
    res.type("html").send(changePasswordPage({ error: "New password must be at least 8 characters." }));
    return;
  }

  if (new_password !== confirm_password) {
    res.type("html").send(changePasswordPage({ error: "New passwords do not match." }));
    return;
  }

  if (current_password === new_password) {
    res.type("html").send(changePasswordPage({ error: "New password must be different from your current password." }));
    return;
  }

  try {
    const result = await changePassword(email, current_password, new_password);

    if (!result.success) {
      res.type("html").send(changePasswordPage({ error: result.error || "Password change failed." }));
      return;
    }

    res.type("html").send(changePasswordPage({ success: "Password changed successfully. You can close this page." }));
  } catch (err: any) {
    res.type("html").send(changePasswordPage({ error: "An error occurred. Please try again." }));
  }
});

// ── TripleSeat OAuth Setup Routes (one-time) ──

app.get("/auth/login", (req, res) => {
  const host = req.headers.host || "tripleseat-mcp.vercel.app";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const redirectUri = protocol + "://" + host + "/auth/callback";
  const authorizeUrl = getAuthorizeUrl(redirectUri);
  res.redirect(authorizeUrl);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code as string;
  const error = req.query.error as string;

  if (error) {
    res.status(400).send(
      "<h1>Authorization Failed</h1><p>Error: " + error + "</p>" +
      "<p>" + (req.query.error_description || "") + "</p>"
    );
    return;
  }

  if (!code) {
    res.status(400).send("<h1>Missing authorization code</h1>");
    return;
  }

  try {
    const host = req.headers.host || "tripleseat-mcp.vercel.app";
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const redirectUri = protocol + "://" + host + "/auth/callback";

    const tokens = await exchangeCodeForTokens(code, redirectUri);

    try {
      await storeTokens(tokens);
      console.log("[Auth Callback] Tokens stored in database successfully");
    } catch (storeErr: any) {
      console.error("[Auth Callback] Failed to store tokens in DB:", storeErr.message);
    }

    res.send(`<!DOCTYPE html>
<html><head><title>TripleSeat MCP - OAuth Setup Complete</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; background: #0a0a0a; color: #ededed; }
  .success { color: #00c853; }
  .token-box { background: #141414; border: 1px solid #262626; padding: 16px; border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 14px; margin: 12px 0; }
  .step { margin: 20px 0; padding: 16px; background: #141414; border-left: 4px solid #0070f3; border-radius: 4px; }
  code { background: #262626; padding: 2px 6px; border-radius: 4px; }
  a { color: #0070f3; }
</style></head>
<body>
  <h1 class="success">OAuth Setup Complete!</h1>
  <p>TripleSeat authorized the Stormbreaker app.</p>
  <h3>Refresh Token:</h3>
  <div class="token-box">${tokens.refresh_token || "NOT PROVIDED"}</div>
  <div class="step">
    <p><strong>1.</strong> Go to <a href="https://vercel.com/mcretzman-9359s-projects/tripleseat-mcp/settings/environment-variables" target="_blank">Vercel Environment Variables</a></p>
    <p><strong>2.</strong> Set <code>TRIPLESEAT_REFRESH_TOKEN</code> to the refresh token above</p>
    <p><strong>3.</strong> Redeploy the project</p>
  </div>
</body></html>`);
  } catch (err: any) {
    res.status(500).send(
      "<h1>Token Exchange Failed</h1><pre>" + err.message + "</pre>"
    );
  }
});

// ── Tool Definitions ──
const TOOLS = [
  {
    name: "get_event",
    description: "Get full event details from TripleSeat by event ID. Returns BEO data, packages, vendors, status, and optionally financial details.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The TripleSeat event ID" },
        include_financials: { type: "boolean", description: "Include financial details", default: false }
      },
      required: ["event_id"]
    }
  },
  {
    name: "search_events",
    description: "Search TripleSeat events by name, date range, status, or venue. Returns summary fields only (id, name, status, dates, location, guest count). Use get_event with the event ID for full details.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (event name, client name)" },
        status: { type: "string", enum: ["DEFINITE", "TENTATIVE", "PROSPECT", "CLOSED", "LOST"], description: "Filter by status" },
        from_date: { type: "string", description: "Start date (MM/DD/YYYY)" },
        to_date: { type: "string", description: "End date (MM/DD/YYYY)" },
        location_id: { type: "string", description: "Filter by venue location ID" },
        page: { type: "number", description: "Page number", default: 1 },
        order: { type: "string", description: "Sort field", default: "event_start" },
        sort_direction: { type: "string", enum: ["asc", "desc"], default: "desc" },
        include_financials: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "list_upcoming_events",
    description: "List events in a date range. Returns summary fields only (id, name, status, dates, location, guest count). Use get_event for full details on any event.",
    inputSchema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Start date (MM/DD/YYYY)" },
        to_date: { type: "string", description: "End date (MM/DD/YYYY)" },
        location_id: { type: "string", description: "Filter to specific venue" },
        include_financials: { type: "boolean", default: false }
      },
      required: ["from_date", "to_date"]
    }
  },
  {
    name: "check_availability",
    description: "Check if a specific date is available at a venue by looking for existing events on that date.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check (MM/DD/YYYY)" },
        location_id: { type: "string", description: "Specific venue to check" }
      },
      required: ["date"]
    }
  },
  {
    name: "get_lead",
    description: "Get full lead details — contact info, budget, date preferences, lead source, qualification data.",
    inputSchema: {
      type: "object",
      properties: { lead_id: { type: "string", description: "The TripleSeat lead ID" } },
      required: ["lead_id"]
    }
  },
  {
    name: "search_leads",
    description: "Search leads by name, email, date, status, or location. Returns summary fields only. Use get_lead for full details.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — name, email, phone" },
        status: { type: "string", description: "Lead status filter" },
        location_id: { type: "string", description: "Filter by venue" },
        from_date: { type: "string", description: "Created after (MM/DD/YYYY)" },
        to_date: { type: "string", description: "Created before (MM/DD/YYYY)" },
        page: { type: "number", default: 1 }
      }
    }
  },
  {
    name: "list_recent_leads",
    description: "Get the most recent leads (summary fields). Use get_lead for full details on any lead.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", default: 1 },
        location_id: { type: "string", description: "Filter by venue" }
      }
    }
  },
  {
    name: "get_booking",
    description: "Get booking details including financial data — payment status, balance due, package totals.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "The TripleSeat booking ID" },
        include_financials: { type: "boolean", default: true }
      },
      required: ["booking_id"]
    }
  },
  {
    name: "search_bookings",
    description: "Search bookings by date range or status. Returns summary fields only. Use get_booking for full details.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        from_date: { type: "string", description: "MM/DD/YYYY" },
        to_date: { type: "string", description: "MM/DD/YYYY" },
        page: { type: "number", default: 1 },
        order: { type: "string", default: "created_at" },
        sort_direction: { type: "string", enum: ["asc", "desc"], default: "desc" },
        include_financials: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "get_contact",
    description: "Get contact details — name, email, phone, associated account.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"]
    }
  },
  {
    name: "search_contacts",
    description: "Search contacts by name, email, or phone. Returns summary fields only. Use get_contact for full details.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, page: { type: "number", default: 1 } },
      required: ["query"]
    }
  },
  {
    name: "get_account",
    description: "Get account details — business name, contacts, associated events.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      required: ["account_id"]
    }
  },
  {
    name: "search_accounts",
    description: "Search accounts by name or email. Returns summary fields only. Use get_account for full details.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, page: { type: "number", default: 1 } },
      required: ["query"]
    }
  },
  {
    name: "list_sites",
    description: "List all sites (top-level venue groups).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_locations",
    description: "List all venue locations and their rooms/areas. Returns Knotting Hill Place and Brighton Abbey with spaces and capacities.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_location",
    description: "Get details for a specific venue location — address, rooms, capacity.",
    inputSchema: {
      type: "object",
      properties: { location_id: { type: "string" } },
      required: ["location_id"]
    }
  },
  {
    name: "list_users",
    description: "List all TripleSeat users (team members).",
    inputSchema: { type: "object", properties: {} }
  },

  // ── Write Tools ──

  {
    name: "create_lead",
    description: "Create a new lead in TripleSeat. Requires first_name, last_name, email_address, and phone_number at minimum.",
    inputSchema: {
      type: "object",
      properties: {
        first_name: { type: "string", description: "Contact first name" },
        last_name: { type: "string", description: "Contact last name" },
        email_address: { type: "string", description: "Contact email" },
        phone_number: { type: "string", description: "Contact phone number" },
        company: { type: "string", description: "Company or organization name" },
        event_description: { type: "string", description: "Nature of event (becomes the event name when converted)" },
        event_date: { type: "string", description: "Requested event date (MM/DD/YYYY)" },
        start_time: { type: "string", description: "Requested start time (e.g. 3:00 PM)" },
        end_time: { type: "string", description: "Requested end time (e.g. 5:00 PM)" },
        guest_count: { type: "number", description: "Expected number of guests" },
        location_id: { type: "number", description: "Location ID (required if multiple locations)" },
        additional_information: { type: "string", description: "Additional details or notes" },
        contact_preference: { type: "string", enum: ["Email", "Phone"], description: "Preferred contact method" }
      },
      required: ["first_name", "last_name", "email_address", "phone_number"]
    }
  },
  {
    name: "update_lead",
    description: "Update an existing lead in TripleSeat. Only include fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "The TripleSeat lead ID to update" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email_address: { type: "string" },
        phone_number: { type: "string" },
        company: { type: "string" },
        event_description: { type: "string" },
        event_date: { type: "string", description: "MM/DD/YYYY" },
        start_time: { type: "string" },
        end_time: { type: "string" },
        guest_count: { type: "number" },
        location_id: { type: "number" },
        additional_information: { type: "string" },
        status: { type: "string" }
      },
      required: ["lead_id"]
    }
  },
  {
    name: "create_booking",
    description: "Create a new booking in TripleSeat. Requires name, start_date, end_date, and location_id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Booking name" },
        start_date: { type: "string", description: "Start date (MM/DD/YYYY)" },
        end_date: { type: "string", description: "End date (MM/DD/YYYY)" },
        location_id: { type: "number", description: "Location ID for the venue" },
        account_id: { type: "number", description: "Account ID to associate" },
        contact_id: { type: "number", description: "Primary contact ID" },
        status: { type: "string", description: "Booking status" },
        description: { type: "string", description: "Booking description or notes" }
      },
      required: ["name", "start_date", "end_date", "location_id"]
    }
  },
  {
    name: "update_booking",
    description: "Update an existing booking in TripleSeat. Only include fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "The TripleSeat booking ID to update" },
        name: { type: "string" },
        start_date: { type: "string", description: "MM/DD/YYYY" },
        end_date: { type: "string", description: "MM/DD/YYYY" },
        location_id: { type: "number" },
        status: { type: "string" },
        description: { type: "string" }
      },
      required: ["booking_id"]
    }
  },
  {
    name: "create_event",
    description: "Create a new event in TripleSeat. Requires name, event_start, event_end, account_id, contact_id, location_id, room_ids, and status.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name" },
        event_start: { type: "string", description: "Event start date/time (MM/DD/YYYY HH:MM AM/PM)" },
        event_end: { type: "string", description: "Event end date/time (MM/DD/YYYY HH:MM AM/PM)" },
        account_id: { type: "number", description: "Account ID" },
        contact_id: { type: "number", description: "Primary contact ID" },
        location_id: { type: "number", description: "Location ID" },
        room_ids: { type: "array", items: { type: "number" }, description: "Array of room IDs for the event" },
        status: { type: "string", enum: ["DEFINITE", "TENTATIVE", "PROSPECT", "CLOSED", "LOST"], description: "Event status" },
        guest_count: { type: "number", description: "Expected guest count" },
        description: { type: "string", description: "Event description" }
      },
      required: ["name", "event_start", "event_end", "account_id", "contact_id", "location_id", "room_ids", "status"]
    }
  },
  {
    name: "update_event",
    description: "Update an existing event in TripleSeat. Only include fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The TripleSeat event ID to update" },
        name: { type: "string" },
        event_start: { type: "string", description: "MM/DD/YYYY HH:MM AM/PM" },
        event_end: { type: "string", description: "MM/DD/YYYY HH:MM AM/PM" },
        status: { type: "string", enum: ["DEFINITE", "TENTATIVE", "PROSPECT", "CLOSED", "LOST"] },
        guest_count: { type: "number" },
        description: { type: "string" },
        room_ids: { type: "array", items: { type: "number" } }
      },
      required: ["event_id"]
    }
  },
  {
    name: "create_contact",
    description: "Create a new contact in TripleSeat. Requires first_name and account_id. Include site_id if there are multiple sites.",
    inputSchema: {
      type: "object",
      properties: {
        first_name: { type: "string", description: "Contact first name" },
        last_name: { type: "string", description: "Contact last name" },
        account_id: { type: "number", description: "Account to associate the contact with" },
        site_id: { type: "number", description: "Site ID (only required if multiple sites exist)" },
        email: { type: "string", description: "Email address" },
        phone: { type: "string", description: "Phone number" },
        title: { type: "string", description: "Job title" }
      },
      required: ["first_name", "account_id"]
    }
  },
  {
    name: "update_contact",
    description: "Update an existing contact in TripleSeat. Only include fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "The TripleSeat contact ID to update" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        title: { type: "string" },
        company: { type: "string" }
      },
      required: ["contact_id"]
    }
  },
  {
    name: "create_account",
    description: "Create a new account in TripleSeat. Requires name. Include site_id if there are multiple sites.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Account/business name" },
        site_id: { type: "number", description: "Site ID (only required if multiple sites exist)" },
        description: { type: "string", description: "Account description" },
        email: { type: "string", description: "Account email" },
        phone: { type: "string", description: "Account phone number" }
      },
      required: ["name"]
    }
  },
  {
    name: "update_account",
    description: "Update an existing account in TripleSeat. Only include fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "The TripleSeat account ID to update" },
        name: { type: "string" },
        description: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" }
      },
      required: ["account_id"]
    }
  },
  {
    name: "create_lead_task",
    description: "Create a task on a lead in TripleSeat.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "The lead ID to add the task to" },
        body: { type: "string", description: "Task description" },
        due_date: { type: "string", description: "Due date/time in ISO 8601 format" },
        priority: { type: "number", enum: [1, 2, 3], description: "Priority: 1=Low, 2=Medium, 3=High" },
        task_type_id: { type: "number", description: "Task type ID (see Sites API for available types)" },
        assignee_ids: { type: "array", items: { type: "number" }, description: "User IDs to assign the task to" },
        site_id: { type: "number", description: "Site ID the lead belongs to" }
      },
      required: ["lead_id", "body", "due_date", "priority", "task_type_id", "assignee_ids", "site_id"]
    }
  },
  {
    name: "create_booking_task",
    description: "Create a task on a booking in TripleSeat.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "The booking ID to add the task to" },
        body: { type: "string", description: "Task description" },
        due_date: { type: "string", description: "Due date/time in ISO 8601 format" },
        priority: { type: "number", enum: [1, 2, 3], description: "Priority: 1=Low, 2=Medium, 3=High" },
        task_type_id: { type: "number", description: "Task type ID (see Sites API for available types)" },
        assignee_ids: { type: "array", items: { type: "number" }, description: "User IDs to assign the task to" },
        site_id: { type: "number", description: "Site ID the booking belongs to" }
      },
      required: ["booking_id", "body", "due_date", "priority", "task_type_id", "assignee_ids", "site_id"]
    }
  },
  {
    name: "create_contact_task",
    description: "Create a task on a contact in TripleSeat.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "The contact ID to add the task to" },
        body: { type: "string", description: "Task description" },
        due_date: { type: "string", description: "Due date/time in ISO 8601 format" },
        priority: { type: "number", enum: [1, 2, 3], description: "Priority: 1=Low, 2=Medium, 3=High" },
        task_type_id: { type: "number", description: "Task type ID (see Sites API for available types)" },
        assignee_ids: { type: "array", items: { type: "number" }, description: "User IDs to assign the task to" },
        site_id: { type: "number", description: "Site ID the contact belongs to" }
      },
      required: ["contact_id", "body", "due_date", "priority", "task_type_id", "assignee_ids", "site_id"]
    }
  }
];

// ── Response Size Management ──
const MAX_RESPONSE_CHARS = 12000;

const EVENT_SUMMARY_FIELDS = ["id", "name", "status", "event_start", "event_end", "location", "location_id", "room", "guest_count", "created_at"];
const LEAD_SUMMARY_FIELDS = ["id", "first_name", "last_name", "email", "phone", "status", "location", "location_id", "event_date", "guest_count", "created_at", "lead_source"];
const BOOKING_SUMMARY_FIELDS = ["id", "event_id", "status", "total", "balance_due", "created_at", "location", "location_id"];
const CONTACT_SUMMARY_FIELDS = ["id", "first_name", "last_name", "email", "phone", "company", "account_id"];
const ACCOUNT_SUMMARY_FIELDS = ["id", "name", "email", "phone", "address"];

function summarizeItem(item: any, fields: string[]): any {
  if (!item || typeof item !== "object") return item;
  const summary: any = {};
  for (const f of fields) {
    if (item[f] !== undefined) summary[f] = item[f];
  }
  return summary;
}

function summarizeList(data: any, fields: string[]): { items: any[]; total?: number; page?: number; truncatedFields: boolean } {
  const items = Array.isArray(data) ? data : (data as any)?.results || (data as any)?.data || [];
  const summarized = items.map((item: any) => summarizeItem(item, fields));
  return {
    items: summarized,
    total: (data as any)?.total_count ?? items.length,
    page: (data as any)?.page,
    truncatedFields: true,
  };
}

function truncateResponse(text: string, toolName: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  const hint = toolName.startsWith("search_") || toolName.startsWith("list_")
    ? `\n\n[Response truncated at ${MAX_RESPONSE_CHARS} chars. Use get_event, get_lead, get_booking, or get_contact for full details on specific items.]`
    : `\n\n[Response truncated at ${MAX_RESPONSE_CHARS} chars.]`;
  return text.substring(0, MAX_RESPONSE_CHARS) + hint;
}

// ── Tool Execution ──
async function executeTool(name: string, args: any): Promise<string> {
  const params: Record<string, string> = {};

  switch (name) {
    case "get_event": {
      if (args.include_financials) params.show_financial = "true";
      const { data } = await tripleseatGet(`/events/${args.event_id}`, params);
      return JSON.stringify(data, null, 2);
    }
    case "search_events": {
      if (args.query) params.query = args.query;
      if (args.status) params.status = args.status;
      if (args.from_date) params.event_start_date = args.from_date;
      if (args.to_date) params.event_end_date = args.to_date;
      if (args.location_id) params.location_id = args.location_id;
      if (args.page) params.page = String(args.page);
      if (args.order) params.order = args.order;
      if (args.sort_direction) params.sort_direction = args.sort_direction;
      if (args.include_financials) params.show_financial = "true";
      const { data } = await tripleseatGet("/events/search", params);
      const result = summarizeList(data, EVENT_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "list_upcoming_events": {
      params.event_start_date = args.from_date;
      params.event_end_date = args.to_date;
      params.order = "event_start";
      params.sort_direction = "asc";
      if (args.location_id) params.location_id = args.location_id;
      if (args.include_financials) params.show_financial = "true";
      const { data } = await tripleseatGet("/events/search", params);
      const result = summarizeList(data, EVENT_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "check_availability": {
      params.event_start_date = args.date;
      params.event_end_date = args.date;
      params.order = "event_start";
      params.sort_direction = "asc";
      if (args.location_id) params.location_id = args.location_id;
      const { data } = await tripleseatGet("/events/search", params);
      const events = Array.isArray(data) ? data : (data as any)?.results || [];
      const summary = events.length === 0
        ? `No events found on ${args.date}. The date appears to be available.`
        : `Found ${events.length} event(s) on ${args.date}.`;
      const summarized = summarizeList(data, EVENT_SUMMARY_FIELDS);
      return truncateResponse(summary + "\n" + JSON.stringify(summarized), name);
    }
    case "get_lead": {
      const { data } = await tripleseatGet(`/leads/${args.lead_id}`);
      return JSON.stringify(data, null, 2);
    }
    case "search_leads": {
      if (args.query) params.query = args.query;
      if (args.status) params.status = args.status;
      if (args.location_id) params.location_id = args.location_id;
      if (args.from_date) params.from_date = args.from_date;
      if (args.to_date) params.to_date = args.to_date;
      if (args.page) params.page = String(args.page);
      params.order = "created_at";
      params.sort_direction = "desc";
      const { data } = await tripleseatGet("/leads/search", params);
      const result = summarizeList(data, LEAD_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "list_recent_leads": {
      if (args.page) params.page = String(args.page);
      if (args.location_id) params.location_id = args.location_id;
      params.order = "created_at";
      params.sort_direction = "desc";
      const { data } = await tripleseatGet("/leads/search", params);
      const result = summarizeList(data, LEAD_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "get_booking": {
      if (args.include_financials !== false) params.show_financial = "true";
      const { data } = await tripleseatGet(`/bookings/${args.booking_id}`, params);
      return JSON.stringify(data, null, 2);
    }
    case "search_bookings": {
      if (args.query) params.query = args.query;
      if (args.from_date) params.booking_start_date = args.from_date;
      if (args.to_date) params.booking_end_date = args.to_date;
      if (args.page) params.page = String(args.page);
      params.order = args.order || "created_at";
      params.sort_direction = args.sort_direction || "desc";
      if (args.include_financials) params.show_financial = "true";
      const { data } = await tripleseatGet("/bookings/search", params);
      const result = summarizeList(data, BOOKING_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "get_contact": {
      const { data } = await tripleseatGet(`/contacts/${args.contact_id}`);
      return JSON.stringify(data, null, 2);
    }
    case "search_contacts": {
      params.query = args.query;
      if (args.page) params.page = String(args.page);
      const { data } = await tripleseatGet("/contacts/search", params);
      const result = summarizeList(data, CONTACT_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "get_account": {
      const { data } = await tripleseatGet(`/accounts/${args.account_id}`);
      return JSON.stringify(data, null, 2);
    }
    case "search_accounts": {
      params.query = args.query;
      if (args.page) params.page = String(args.page);
      const { data } = await tripleseatGet("/accounts/search", params);
      const result = summarizeList(data, ACCOUNT_SUMMARY_FIELDS);
      return truncateResponse(JSON.stringify(result), name);
    }
    case "list_sites": {
      const { data } = await tripleseatGet("/sites");
      return JSON.stringify(data, null, 2);
    }
    case "list_locations": {
      const { data } = await tripleseatGet("/locations");
      return JSON.stringify(data, null, 2);
    }
    case "get_location": {
      const { data } = await tripleseatGet(`/locations/${args.location_id}`);
      return JSON.stringify(data, null, 2);
    }
    case "list_users": {
      const { data } = await tripleseatGet("/users");
      return JSON.stringify(data, null, 2);
    }

    // ── Write Tools ──

    case "create_lead": {
      const { lead_id, ...leadFields } = args;
      const { data } = await tripleseatPost("/leads", { lead: leadFields });
      return JSON.stringify(data, null, 2);
    }
    case "update_lead": {
      const { lead_id, ...leadFields } = args;
      const { data } = await tripleseatPut(`/leads/${lead_id}`, { lead: leadFields });
      return JSON.stringify(data, null, 2);
    }
    case "create_booking": {
      const { data } = await tripleseatPost("/bookings", { booking: args });
      return JSON.stringify(data, null, 2);
    }
    case "update_booking": {
      const { booking_id, ...bookingFields } = args;
      const { data } = await tripleseatPut(`/bookings/${booking_id}`, { booking: bookingFields });
      return JSON.stringify(data, null, 2);
    }
    case "create_event": {
      const { data } = await tripleseatPost("/events", { event: args });
      return JSON.stringify(data, null, 2);
    }
    case "update_event": {
      const { event_id, ...eventFields } = args;
      const { data } = await tripleseatPut(`/events/${event_id}`, { event: eventFields });
      return JSON.stringify(data, null, 2);
    }
    case "create_contact": {
      const { site_id, ...contactFields } = args;
      const body: Record<string, any> = { contact: contactFields };
      if (site_id) body.site_id = site_id;
      const { data } = await tripleseatPost("/contacts", body);
      return JSON.stringify(data, null, 2);
    }
    case "update_contact": {
      const { contact_id, ...contactFields } = args;
      const { data } = await tripleseatPut(`/contacts/${contact_id}`, { contact: contactFields });
      return JSON.stringify(data, null, 2);
    }
    case "create_account": {
      const { site_id: acctSiteId, ...accountFields } = args;
      const body: Record<string, any> = { account: accountFields };
      if (acctSiteId) body.site_id = acctSiteId;
      const { data } = await tripleseatPost("/accounts", body);
      return JSON.stringify(data, null, 2);
    }
    case "update_account": {
      const { account_id, ...accountFields } = args;
      const { data } = await tripleseatPut(`/accounts/${account_id}`, { account: accountFields });
      return JSON.stringify(data, null, 2);
    }
    case "create_lead_task": {
      const { lead_id: taskLeadId, ...taskFields } = args;
      const { data } = await tripleseatPost(`/leads/${taskLeadId}/tasks`, taskFields);
      return JSON.stringify(data, null, 2);
    }
    case "create_booking_task": {
      const { booking_id: taskBookingId, ...taskFields } = args;
      const { data } = await tripleseatPost(`/bookings/${taskBookingId}/tasks`, taskFields);
      return JSON.stringify(data, null, 2);
    }
    case "create_contact_task": {
      const { contact_id: taskContactId, ...taskFields } = args;
      const { data } = await tripleseatPost(`/contacts/${taskContactId}/tasks`, taskFields);
      return JSON.stringify(data, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server Info ──
const SERVER_INFO = {
  name: "tripleseat",
  version: "1.0.0",
};

const SERVER_INSTRUCTIONS = `You are connected to TripleSeat, a CRM and event management platform for wedding and event venues. This server provides live read AND write access to event data, leads, bookings, contacts, accounts, and venue locations.

Key context for this installation:
- Two venues: Knotting Hill Place and Brighton Abbey (both in the DFW area, ~10 minutes apart)
- The team handles ~700 inbound leads per month, booking 40-50 weddings
- Events always have at least: a booking, account, contact, location, and room
- Financial data is available on events and bookings when requested
- Use location IDs to filter results by venue when the user asks about a specific property

IMPORTANT — Response size management:
- Search and list tools return SUMMARY fields only (id, name, dates, status, location) to conserve context window
- To get full details (BEOs, packages, vendors, financials), use the get_event, get_lead, get_booking, or get_contact tools with the specific ID
- Always use the search/list → then get_detail pattern: find items first, then drill into the ones the user cares about
- Do NOT call get_event/get_lead/get_booking for every item in a list — only fetch full details when the user asks about a specific item

IMPORTANT — Write operations safety:
- ALWAYS confirm with the user before creating or modifying any records
- Summarize exactly what will be created or changed and get explicit approval before calling a write tool
- For updates, show the current value and the proposed new value so the user can verify
- Never bulk-create or bulk-update records without per-record user confirmation
- When creating events, all required fields must be provided: name, event_start, event_end, account_id, contact_id, location_id, room_ids, and status
- When creating leads, first_name, last_name, email_address, and phone_number are required
- Task creation requires body, due_date, priority, task_type_id, assignee_ids, and site_id

When answering questions:
- Be specific with dates, names, and numbers pulled from the data
- Flag any missing or incomplete fields — data quality visibility is a feature
- If a search returns no results, suggest broadening the query
- For availability checks, always check both venues unless told otherwise`;

// ── JSON-RPC Handler ──
function jsonrpcResponse(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg: any, req: express.Request): Promise<any> {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return jsonrpcResponse(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return jsonrpcResponse(id, {});

    case "tools/list": {
      let tools = TOOLS;
      if (req.user?.role?.allowed_tools) {
        const allowed = new Set(req.user.role.allowed_tools);
        tools = TOOLS.filter((t) => allowed.has(t.name));
      }
      return jsonrpcResponse(id, { tools });
    }

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (req.user?.role?.allowed_tools) {
        if (!req.user.role.allowed_tools.includes(toolName)) {
          return jsonrpcError(id, -32001, `Tool "${toolName}" is not allowed for your role "${req.user.role.name}"`);
        }
      }

      // Strip financials for roles without booking access
      if (req.user?.role?.allowed_tools && !req.user.role.allowed_tools.includes("get_booking")) {
        toolArgs.include_financials = false;
      }

      const startTime = Date.now();
      try {
        const result = await executeTool(toolName, toolArgs);
        const durationMs = Date.now() - startTime;

        logToolCall(req.user?.id || null, toolName, toolArgs, true, undefined, durationMs);

        return jsonrpcResponse(id, {
          content: [{ type: "text", text: result }],
        });
      } catch (error: any) {
        const durationMs = Date.now() - startTime;

        logToolCall(req.user?.id || null, toolName, toolArgs, false, error.message, durationMs);

        return jsonrpcResponse(id, {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── MCP Endpoint ──
app.post("/mcp", oauthTokenAuth, async (req, res) => {
  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((msg: any) => handleMessage(msg, req)));
      const responses = results.filter((r) => r !== null);
      if (responses.length === 0) {
        res.status(202).end();
      } else {
        res.json(responses);
      }
      return;
    }

    const result = await handleMessage(body, req);
    if (result === null) {
      res.status(202).end();
    } else {
      res.json(result);
    }
  } catch (error: any) {
    console.error("[MCP Error]", error);
    res.status(500).json(jsonrpcError(null, -32603, "Internal server error"));
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json(jsonrpcError(null, -32000, "Use POST for MCP requests"));
});

app.delete("/mcp", (_req, res) => {
  res.status(200).json({ ok: true });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`\nTripleSeat MCP Server running on http://localhost:${PORT}`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  Admin panel:  http://localhost:${PORT}/admin/login`);
    console.log(`  OAuth:        http://localhost:${PORT}/.well-known/oauth-authorization-server`);
    console.log(`  Credentials:  ${hasCredentials() ? "configured" : "missing"}`);
    console.log();
  });
}

export default app;
