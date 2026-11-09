# TripleSeat MCP Server

Connects Claude AI to TripleSeat CRM via the Model Context Protocol. Your team asks questions in plain English — Claude queries TripleSeat in real time and answers.

Built for **Knotting Hill Place** and **Brighton Abbey** by [Stormbreaker Digital](mailto:matt@stormbreakerdigital.com).

## What It Does

15 read tools across 6 domains:

| Domain | Tools | Examples |
|--------|-------|---------|
| **Events** | `get_event`, `search_events`, `list_upcoming_events`, `check_availability` | "What's the beverage package for the Martinez wedding?" |
| **Leads** | `get_lead`, `search_leads`, `list_recent_leads` | "Show me all leads from the last 7 days" |
| **Bookings** | `get_booking`, `search_bookings` | "What's the balance due on the Johnson booking?" |
| **Contacts** | `get_contact`, `search_contacts` | "Find me Sarah Chen's contact info" |
| **Accounts** | `get_account`, `search_accounts` | "Pull up the Riverside Corp account" |
| **Locations** | `list_sites`, `list_locations`, `get_location`, `list_users` | "Show me all rooms at Brighton Abbey" |

## Setup

### 1. Get TripleSeat API Credentials

In TripleSeat: **Settings → API/Webhooks → OAuth 2.0 Client Applications → + New Application**

You need the **Client ID** and **Client Secret**.

### 2. Deploy to Vercel

```bash
# Clone the repo
git clone https://github.com/YOUR_ORG/tripleseat-mcp.git
cd tripleseat-mcp

# Install and build
npm install
npm run build

# Deploy
vercel deploy --prod
```

Set environment variables in Vercel:
- `TRIPLESEAT_CLIENT_ID` → your Client ID
- `TRIPLESEAT_CLIENT_SECRET` → your Client Secret

### 3. Connect to Claude

In Claude.ai: **Settings → Connectors → Add Custom Connector**

Paste your Vercel URL: `https://your-app.vercel.app/mcp`

Done. Every team member on the workspace gets access automatically.

## Local Development

```bash
cp .env.example .env
# Fill in your credentials

npm install
npm run build
npm start
# Server runs at http://localhost:3000/mcp
```

## Architecture

```
Claude.ai ←→ /mcp endpoint ←→ TripleSeat REST API
                  ↑
          Streamable HTTP transport
          OAuth 2.0 token management
          Stateless (Vercel-compatible)
```

- **Transport**: Streamable HTTP (MCP spec 2025-03-26)
- **Auth**: OAuth 2.0 client_credentials grant with auto-refresh
- **Hosting**: Vercel serverless functions
- **Stateless**: Each request is independent — scales horizontally

## Phase 2 (Coming Soon)

Write tools: `create_lead`, `update_event`, `update_booking`, `create_contact`, `add_discussion`

Webhooks: New lead alerts, 48-hour response monitor, BEO completeness checker

---

**Questions?** matt@stormbreakerdigital.com

## Inquiry agent (The Village)

`src/agent/` answers guest inquiries that arrive by email (Tripleseat discussion notifications,
The Knot / WeddingWire, Zola, and direct mail to events@ / info@ / patrick@) in The Village voice.

Flow (every 5 minutes, `/agent/cron/poll`): new mail is queued, sorted by source, triaged by Claude
(inquiry or not, department, topics, dates, escalation), checked against Tripleseat (existing lead or
event, date availability), answered from the approved FAQ answers and house rules, checked twice
(code rules plus a separate review model), then sent. Every guest email leaves from events@. Event conversations live in Tripleseat: an event
inquiry that arrives by The Knot, WeddingWire, Zola or direct email becomes a Tripleseat lead and is
answered on the lead's Tripleseat discussion thread (by replying, from events@, to the Tripleseat
discussion email, which carries the thread token). Non-event questions (Solstice, Bodega, yoga) are
answered by email from events@.
Anything about money, contract changes, booked-date changes, fire or road closures, complaints,
press or custom pricing goes to a person instead.

Visibility: every sent reply is copied to Patrick with a "Correct this reply" link; `/admin/agent`
shows the full log; corrections become rules the agent follows from then on; a daily digest lists
everything plus the questions the FAQ couldn't answer.

Business facts are not stored in this repository: FAQ answers sync hourly from the FAQ Google Sheet
(`/agent/cron/kb-sync`) and house rules are edited at `/admin/agent/settings`.

Set the Vercel project's Function Max Duration to 300 seconds. Start in `AGENT_MODE=shadow`.
