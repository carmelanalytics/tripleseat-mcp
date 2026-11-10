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

### Flow (every 5 minutes, `/agent/cron/poll`)

1. New mail is queued and sorted by source.
2. Claude triages it: inquiry or not, department, topics, dates, who is writing, whether a person must take it.
3. Tripleseat is checked for an existing lead or event and for the date.
4. The reply plan is decided in code: how the reply ends, the sign-off, whether a tour P.S. is due.
5. Claude writes the reply from the approved FAQ answers and house rules, using a few of Patrick's own
   past replies as voice examples. With three or more examples loaded it writes two drafts and keeps
   the one the review model judges closer to Patrick's.
6. Yes/no checks run (rule checks in code, the rest by a separate review model). A failed blocking
   check gets one automatic rewrite, then a person.
7. Fixed wording is added in code: the AI disclosure and, where due, the inquiry form invitation.
8. The reply is sent (`live`) or only drafted (`shadow`). Either way Patrick gets a copy.

### Where a reply goes

- **Event conversations run in Tripleseat, from events@.** A message that arrives on a Tripleseat
  discussion thread is answered on that thread.
- **Event guests who write in from outside Tripleseat** (direct email, The Knot, WeddingWire, Zola)
  and are not in Tripleseat yet get a reply from events@ whose last paragraph invites them to fill
  out the Tripleseat events inquiry form, the way the events team always has. The form creates the
  lead, so the agent does not create one and nothing is duplicated. When that lead appears, the
  agent writes "ORIGIN: ..." on it. After `AGENT_FORM_INVITE_MAX` invitations (default 2) with no
  form, the conversation goes to a person; the digest lists guests invited more than three days ago
  who are still not in Tripleseat. The Knot is skipped here when `AGENT_KNOT_NATIVE=true`, because
  The Knot's own Tripleseat integration creates that lead. A marketplace notice with no guest email
  address goes to a person. Blank the form link in settings to switch the invitation off; the agent
  then creates the lead itself.
- **Solstice, Bodega, yoga and general questions** are answered from info@ with the department
  copied (solstice@, bodega@ or yoga@).
- Money, contract changes, booked-date changes, fire or road closures, complaints, press, custom
  pricing, an angry guest or a mainly personal note go to a person, with a short brief.

### How a reply is built

- Event prospects: answer first, then one question in its own last paragraph, picked by the state of
  the date (open, taken, none given). The tour invitation is a P.S.
- The first reply to an event prospect, on a Tripleseat thread or by email, closes with "How'd you
  come across us? A friend, a scroll, or a detour down Highway 1?" unless the source is already
  known (a marketplace inquiry, a source on the Tripleseat lead, or the guest said so). It is added
  in code, replaces the date question in that reply, and is editable in settings. When the guest
  answers, the agent writes "ORIGIN: ..." on the Tripleseat lead and sets the Lead Source.
- The Event Info Packet is mentioned only when the guest asks for it. Otherwise the events team sends it.
- AI disclosure: one sentence in the first reply and a footer on every reply, both added in code and
  editable in settings (California Business and Professions Code 17940 to 17943).

### Visibility and scoring

- Every reply, sent or drafted, is copied to Patrick with the question "Would you have sent this
  unchanged?" and Yes / No buttons. The buttons open `/agent/answer/:id` (a signed link, no sign-in);
  the answer is recorded when the button on that page is pressed. Those answers are the score, shown
  on the confirmation page and in the daily digest.
- `/admin/agent` shows the full log. On a message page Patrick can correct the reply (corrections
  become rules), label each check pass or fail, and pick blind between the two drafts.
- `/admin/agent/checks` shows each check's agreement with Patrick's labels. A check counts as
  validated at 100 labels with 90% agreement and 80% of his fails caught. Each check can be set to
  block or to note only.
- `/admin/agent/exemplars` holds Patrick's own replies (JSON import). Guest names and dollar amounts
  are blanked in the copy the agent writes from.
- The daily digest lists everything, the questions the FAQ could not answer, what was not answered
  and why, and the checks that failed most.

### Setup

Business facts are not stored in this repository: FAQ answers sync hourly from the FAQ Google Sheet
(`/agent/cron/kb-sync`) and house rules are edited at `/admin/agent/settings`.

- Tripleseat: site 12601, location 24590 (`TRIPLESEAT_LOCATION_ID`, `TRIPLESEAT_SITE_ID`).
- Microsoft 365: an app registration with Mail.ReadWrite and Mail.Send (application), limited by an
  Exchange application access policy to events@, info@ and patrick@.
- `PUBLIC_BASE_URL` and `CRON_SECRET` (or `AGENT_LINK_SECRET`) are needed for the Yes / No links.
- Set the Vercel project's Function Max Duration to 300 seconds. Start in `AGENT_MODE=shadow`.
