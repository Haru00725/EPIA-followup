/**
 * Task 2 — AI Follow-Up Automation Module
 *
 * This module:
 *  1. Identifies patients whose follow-up is due today (or overdue).
 *  2. Generates a personalized WhatsApp follow-up draft using an AI model
 *     (OpenAI-compatible API), falling back to a deterministic mock when
 *     the API is unavailable.
 *  3. Exposes the drafts via REST endpoints so a staff member can review,
 *     edit, and approve each message before it would be sent.
 *
 * No WhatsApp messages are ever sent automatically — the "send" action
 * simply records approval in the database.
 */

const crypto = require("crypto");

// ──────────────────────────────────────────────────────────────
//  Mock AI generator — used when no real AI API key is provided
// ──────────────────────────────────────────────────────────────

function daysBetween(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00Z`);
  const b = new Date(`${dateB}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function mockGenerateDraft(patient, today) {
  const firstName = patient.name.split(/\s+/)[0];
  const gap = daysBetween(patient.consultation_date, today);
  const overdue = patient.next_follow_up_date < today;

  let greeting, body;

  if (overdue) {
    greeting = `Hi ${firstName}, this is a gentle reminder from your healthcare team.`;
    body =
      `We noticed your follow-up visit scheduled for ${patient.next_follow_up_date} ` +
      `has not been completed yet. It has been ${gap} days since your consultation ` +
      `on ${patient.consultation_date}. Your health is important to us — could you ` +
      `please let us know a convenient time to reschedule?`;
  } else {
    greeting = `Hello ${firstName}! 😊`;
    body =
      `This is a friendly reminder that your follow-up visit is scheduled for today ` +
      `(${patient.next_follow_up_date}). It has been ${gap} days since your last ` +
      `consultation on ${patient.consultation_date}. We look forward to seeing you ` +
      `and checking on your progress!`;
  }

  return `${greeting}\n\n${body}\n\nPlease reply to confirm, or call us to reschedule.\nThank you! 🙏`;
}

// ──────────────────────────────────────────────────────────────
//  Real AI generator — calls an OpenAI-compatible chat endpoint
// ──────────────────────────────────────────────────────────────

async function aiGenerateDraft(patient, today, { apiKey, apiBase, model } = {}) {
  const base = (apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const systemPrompt =
    `You are a polite, empathetic medical receptionist. Write a short WhatsApp ` +
    `follow-up message (3–5 sentences) for the patient. Be warm but professional. ` +
    `Include the patient's first name, their consultation date, and their follow-up ` +
    `date. End with a call to action asking them to confirm or reschedule. ` +
    `Today's date is ${today}.`;

  const userPrompt =
    `Patient: ${patient.name}\n` +
    `Phone: ${patient.phone}\n` +
    `Consultation date: ${patient.consultation_date}\n` +
    `Follow-up date: ${patient.next_follow_up_date}\n` +
    `Status: ${patient.next_follow_up_date < today ? "overdue" : "due today"}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI API returned ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ──────────────────────────────────────────────────────────────
//  Unified draft generator — tries real AI, falls back to mock
// ──────────────────────────────────────────────────────────────

async function generateDraft(patient, today, aiConfig) {
  const isAiAvailable = aiConfig && aiConfig.apiKey;
  let draft, source;

  if (isAiAvailable) {
    try {
      draft = await aiGenerateDraft(patient, today, aiConfig);
      source = "ai";
    } catch (err) {
      draft = mockGenerateDraft(patient, today);
      source = "mock (AI unavailable: " + err.message + ")";
    }
  } else {
    draft = mockGenerateDraft(patient, today);
    source = "mock";
  }

  return { draft, source };
}

// ──────────────────────────────────────────────────────────────
//  Express route-builder — adds Task 2 endpoints to the app
// ──────────────────────────────────────────────────────────────

function addFollowUpRoutes(app, db, { today, aiConfig, logger = console } = {}) {
  // In-memory store for generated drafts (keyed by draftId).
  // In production this would be a database table; in-memory is fine for this
  // scope and avoids changing the Task 1 schema.
  const drafts = new Map();

  const q = {
    dueOn: db.prepare(
      `SELECT * FROM patients
       WHERE follow_up_status = 'pending' AND next_follow_up_date = ?
       ORDER BY id`
    ),
    dueOnOrBefore: db.prepare(
      `SELECT * FROM patients
       WHERE follow_up_status = 'pending' AND next_follow_up_date <= ?
       ORDER BY next_follow_up_date, id`
    ),
    get: db.prepare("SELECT * FROM patients WHERE id = ?"),
    complete: db.prepare(
      `UPDATE patients SET follow_up_status = 'completed', completed_at = datetime('now')
       WHERE id = ?`
    ),
  };

  // ── POST /followups/generate-drafts ──────────────────────
  // Identifies due patients and generates a personalized draft for each.
  // Query params: ?include_overdue=true, ?date=YYYY-MM-DD (same as due-today)
  app.post("/followups/generate-drafts", async (req, res) => {
    try {
      const { date, include_overdue } = req.query;
      const day = date || today();
      const patients =
        include_overdue === "true"
          ? q.dueOnOrBefore.all(day)
          : q.dueOn.all(day);

      if (patients.length === 0) {
        return res.json({
          message: "No follow-ups due",
          date: day,
          drafts: [],
        });
      }

      const results = [];
      for (const patient of patients) {
        const { draft, source } = await generateDraft(patient, day, aiConfig);
        const draftId = crypto.randomUUID();
        const entry = {
          draftId,
          patientId: patient.id,
          patientName: patient.name,
          phone: patient.phone,
          consultationDate: patient.consultation_date,
          followUpDate: patient.next_follow_up_date,
          draft,
          source,
          status: "pending_review", // pending_review → approved → sent (simulated)
          createdAt: new Date().toISOString(),
        };
        drafts.set(draftId, entry);
        results.push(entry);
      }

      res.json({
        message: `Generated ${results.length} draft(s)`,
        date: day,
        ai_source: results[0]?.source || "mock",
        drafts: results,
      });
    } catch (err) {
      logger.error(JSON.stringify({ event: "generate_drafts_error", message: err.message }));
      res.status(500).json({ error: "Failed to generate drafts" });
    }
  });

  // ── GET /followups/drafts ───────────────────────────────
  // List all generated drafts, optionally filtered by status.
  app.get("/followups/drafts", (_req, res) => {
    const { status } = _req.query;
    let list = [...drafts.values()];
    if (status) {
      list = list.filter((d) => d.status === status);
    }
    res.json(list);
  });

  // ── GET /followups/drafts/:draftId ──────────────────────
  app.get("/followups/drafts/:draftId", (req, res) => {
    const entry = drafts.get(req.params.draftId);
    if (!entry) return res.status(404).json({ error: "Draft not found" });
    res.json(entry);
  });

  // ── PATCH /followups/drafts/:draftId ────────────────────
  // Staff can: edit the draft text, approve it, or reject it.
  //   { "action": "edit",    "draft": "new text" }
  //   { "action": "approve" }
  //   { "action": "reject"  }
  app.patch("/followups/drafts/:draftId", (req, res) => {
    const entry = drafts.get(req.params.draftId);
    if (!entry) return res.status(404).json({ error: "Draft not found" });

    const { action, draft } = req.body ?? {};

    if (action === "edit") {
      if (typeof draft !== "string" || draft.trim() === "") {
        return res.status(400).json({ error: "draft text is required for edit" });
      }
      if (entry.status !== "pending_review") {
        return res.status(409).json({ error: `Cannot edit a draft that is ${entry.status}` });
      }
      entry.draft = draft.trim();
      entry.editedAt = new Date().toISOString();
      return res.json(entry);
    }

    if (action === "approve") {
      if (entry.status !== "pending_review") {
        return res.status(409).json({ error: `Cannot approve a draft that is ${entry.status}` });
      }
      entry.status = "approved";
      entry.approvedAt = new Date().toISOString();

      // Simulate "sending" the WhatsApp message (no real send).
      entry.status = "sent";
      entry.sentAt = new Date().toISOString();
      entry.sentNote =
        "SIMULATED — no real WhatsApp message was sent. " +
        "In production, this would call the WhatsApp Business API.";

      // Also mark the patient's follow-up as completed.
      const patient = q.get.get(entry.patientId);
      if (patient && patient.follow_up_status === "pending") {
        q.complete.run(patient.id);
      }

      return res.json(entry);
    }

    if (action === "reject") {
      if (entry.status !== "pending_review") {
        return res.status(409).json({ error: `Cannot reject a draft that is ${entry.status}` });
      }
      entry.status = "rejected";
      entry.rejectedAt = new Date().toISOString();
      return res.json(entry);
    }

    return res.status(400).json({
      error: "action must be 'edit', 'approve', or 'reject'",
    });
  });

  // Expose drafts map for testing
  app._drafts = drafts;

  return app;
}

module.exports = { mockGenerateDraft, generateDraft, addFollowUpRoutes };
