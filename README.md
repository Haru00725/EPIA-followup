# Patient Follow-Up System (EPIA Assessment)

## Setup Instructions

Requires **Node.js 18+**.

```bash
cd epia-followup
npm install
npm start          # starts server at http://localhost:3000
```

The SQLite database is created automatically at `data/followups.db` on first run.

**Environment variables (optional):**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `data/followups.db` | SQLite file path |
| `OPENAI_API_KEY` | — | Enables real AI draft generation (mock used if not set) |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | Custom AI endpoint |
| `OPENAI_MODEL` | `gpt-3.5-turbo` | AI model to use |

To run the interactive CLI demo for Task 2:

```bash
node src/followup-cli.js                 # uses today's date
node src/followup-cli.js 2026-11-22      # uses a specific date
```

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^5.3.0 | HTTP server and routing |
| `better-sqlite3` | ^13.2.0 | SQLite database driver |

No additional dependencies are required. Task 2 uses only Node.js built-in modules (`crypto`, `readline`, `fs`).

---

## API Endpoints

### Task 1 — Patient Management

| Method | Endpoint | Purpose | Success |
|---|---|---|---|
| POST | `/patients` | Add a patient | 201 |
| GET | `/patients` | List all patients (optional `?status=pending\|completed`) | 200 |
| GET | `/patients/due-today` | Pending follow-ups due today | 200 |
| GET | `/patients/:id` | Get a single patient | 200 |
| PATCH | `/patients/:id/follow-up` | Update follow-up status to completed or pending | 200 |

**POST `/patients`** request body:
```json
{ "name": "Asha Verma", "phone": "+91 98765 43210", "consultation_date": "2026-11-13", "next_follow_up_date": "2026-11-22" }
```

**GET `/patients/due-today`** query params:
- `?include_overdue=true` — also include earlier pending follow-ups
- `?date=YYYY-MM-DD` — check a specific date instead of today

**PATCH `/patients/:id/follow-up`** request body:
```json
{ "status": "completed" }
```

**Error responses:** `400` (validation), `404` (not found), `409` (status already set).

### Task 2 — AI Follow-Up Automation

| Method | Endpoint | Purpose | Success |
|---|---|---|---|
| POST | `/followups/generate-drafts` | Generate WhatsApp drafts for all due patients | 200 |
| GET | `/followups/drafts` | List all drafts (optional `?status=pending_review\|sent\|rejected`) | 200 |
| GET | `/followups/drafts/:draftId` | Get a single draft | 200 |
| PATCH | `/followups/drafts/:draftId` | Edit, approve, or reject a draft | 200 |

**POST `/followups/generate-drafts`** query params:
- `?date=YYYY-MM-DD` — check a specific date
- `?include_overdue=true` — include overdue pending follow-ups

**PATCH `/followups/drafts/:draftId`** request body:
```json
{ "action": "edit", "draft": "Updated message text" }
{ "action": "approve" }
{ "action": "reject" }
```

Approving a draft simulates a WhatsApp send and marks the patient's follow-up as completed. No real messages are sent.

---

## How to Test

Run the full test suite (22 tests):

```bash
npm test
```

| Test file | Tests | Covers |
|---|---|---|
| `test/api.test.js` | 10 | Validation, error codes, due-today logic, follow-up completion, data persistence |
| `test/ai-followup.test.js` | 12 | Mock draft generation, draft CRUD, approve/reject/edit workflow, idempotency, edge cases |

Tests use an in-memory database and a fixed date (`2026-12-10`), so they are deterministic and never depend on the real date or any external service.
