#!/usr/bin/env node
/**
 * Interactive CLI for the AI Follow-Up Workflow (Task 2)
 *
 * This script demonstrates the full staff workflow:
 *  1. Seeds sample patients (if the database is empty).
 *  2. Generates AI/mock follow-up drafts for patients due today.
 *  3. Presents each draft for staff review (approve / edit / reject / skip).
 *  4. Shows a summary of all actions taken.
 *
 * Usage:
 *   node src/followup-cli.js                 # uses today's date
 *   node src/followup-cli.js 2026-11-22      # uses a specific date
 *
 * No real WhatsApp messages are sent. If OPENAI_API_KEY is set in the
 * environment, real AI drafts are generated; otherwise, deterministic
 * mock drafts are used and a note is printed explaining the limitation.
 */

const readline = require("readline");
const { openDb } = require("./db");
const { mockGenerateDraft, generateDraft } = require("./ai-followup");

// ── Helpers ─────────────────────────────────────────────────

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function divider(char = "─", width = 60) {
  console.log(char.repeat(width));
}

// ── Seed data ───────────────────────────────────────────────

function seedSamplePatients(db, today) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM patients").get().n;
  if (count > 0) return false;

  const insert = db.prepare(
    `INSERT INTO patients (name, phone, consultation_date, next_follow_up_date)
     VALUES (?, ?, ?, ?)`
  );

  const samples = [
    ["Asha Verma", "+919876543210", "2026-11-13", today],
    ["Rahul Singh", "+919123456789", "2026-11-10", today],
    ["Priya Nair", "+918765432109", "2026-11-15", today],
    ["Dr. Amit Desai", "+917654321098", "2026-11-05", "2026-12-20"],
    ["Fatima Shaikh", "+916543210987", "2026-11-01", "2026-11-18"],
  ];

  const tx = db.transaction(() => {
    for (const [name, phone, consult, followUp] of samples) {
      insert.run(name, phone, consult, followUp);
    }
  });
  tx();
  return true;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const today = process.argv[2] || todayLocal();
  const db = openDb();

  const aiConfig = process.env.OPENAI_API_KEY
    ? {
        apiKey: process.env.OPENAI_API_KEY,
        apiBase: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      }
    : null;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   EPIA Patient Follow-Up — AI Automation (Task 2)      ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`  📅  Date:       ${today}`);
  console.log(`  🤖  AI source:  ${aiConfig ? "OpenAI API (" + aiConfig.model + ")" : "Mock (no API key set)"}`);

  if (!aiConfig) {
    console.log(
      "\n  ⚠️  OPENAI_API_KEY is not set. Using deterministic mock drafts."
    );
    console.log(
      "     To use a real AI model, set the environment variable:"
    );
    console.log("       export OPENAI_API_KEY=sk-…\n");
  }

  // Seed data if DB is empty
  const seeded = seedSamplePatients(db, today);
  if (seeded) {
    console.log("  🌱  Seeded 5 sample patients (database was empty).\n");
  }

  // Step 1: Identify patients due today (+ overdue)
  divider("═");
  console.log("  STEP 1 — Identifying patients with follow-ups due\n");

  const duePatients = db
    .prepare(
      `SELECT * FROM patients
       WHERE follow_up_status = 'pending' AND next_follow_up_date <= ?
       ORDER BY next_follow_up_date, id`
    )
    .all(today);

  if (duePatients.length === 0) {
    console.log("  ✅  No follow-ups are due. Nothing to do!\n");
    db.close();
    return;
  }

  console.log(`  Found ${duePatients.length} patient(s) with pending follow-ups:\n`);
  for (const p of duePatients) {
    const tag = p.next_follow_up_date < today ? "⏰ OVERDUE" : "📋 Due today";
    console.log(
      `    ${tag}  #${p.id} ${p.name} (${p.phone}) — ` +
        `consult: ${p.consultation_date}, follow-up: ${p.next_follow_up_date}`
    );
  }

  // Step 2: Generate drafts
  divider("═");
  console.log("\n  STEP 2 — Generating personalized WhatsApp follow-up drafts\n");

  const draftEntries = [];
  for (const patient of duePatients) {
    const { draft, source } = await generateDraft(patient, today, aiConfig);
    draftEntries.push({ patient, draft, source, status: "pending_review" });
  }

  console.log(`  ✅  Generated ${draftEntries.length} draft(s).\n`);

  // Step 3: Interactive review
  divider("═");
  console.log("  STEP 3 — Staff review and approval\n");
  console.log("  For each draft you can:");
  console.log("    [A] Approve and simulate send");
  console.log("    [E] Edit the message, then approve");
  console.log("    [R] Reject (do not send)");
  console.log("    [S] Skip for now\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const complete = db.prepare(
    `UPDATE patients SET follow_up_status = 'completed', completed_at = datetime('now')
     WHERE id = ?`
  );

  for (let i = 0; i < draftEntries.length; i++) {
    const entry = draftEntries[i];
    const p = entry.patient;

    divider("─");
    console.log(
      `\n  📨  Draft ${i + 1}/${draftEntries.length} — ${p.name} (${p.phone})`
    );
    console.log(`      Source: ${entry.source}`);
    console.log(`      Follow-up date: ${p.next_follow_up_date}\n`);
    console.log("  ┌─── Draft message ───────────────────────────────────┐");
    for (const line of entry.draft.split("\n")) {
      console.log(`  │  ${line}`);
    }
    console.log("  └─────────────────────────────────────────────────────┘\n");

    let choice = "";
    while (!["a", "e", "r", "s"].includes(choice)) {
      choice = (
        await ask(rl, "  Action [A]pprove / [E]dit / [R]eject / [S]kip: ")
      )
        .trim()
        .toLowerCase();
    }

    if (choice === "a") {
      entry.status = "approved_and_sent";
      complete.run(p.id);
      console.log(
        `\n  ✅  Approved! Message to ${p.name} has been SIMULATED as sent.`
      );
      console.log(
        "      (No real WhatsApp message was sent — this is a demo.)\n"
      );
    } else if (choice === "e") {
      console.log("\n  Current draft:\n");
      console.log(`  ${entry.draft}\n`);
      const newText = await ask(
        rl,
        "  Enter new message text (single line):\n  > "
      );
      entry.draft = newText.trim() || entry.draft;
      entry.status = "approved_and_sent";
      complete.run(p.id);
      console.log(
        `\n  ✅  Edited and approved! Message to ${p.name} SIMULATED as sent.\n`
      );
    } else if (choice === "r") {
      entry.status = "rejected";
      console.log(`\n  ❌  Draft for ${p.name} rejected. No message sent.\n`);
    } else {
      entry.status = "skipped";
      console.log(`\n  ⏭️   Skipped ${p.name}. No action taken.\n`);
    }
  }

  rl.close();

  // Step 4: Summary
  divider("═");
  console.log("\n  STEP 4 — Summary\n");

  const counts = { approved_and_sent: 0, rejected: 0, skipped: 0 };
  for (const e of draftEntries) counts[e.status] = (counts[e.status] || 0) + 1;

  console.log(`    ✅  Approved & sent (simulated): ${counts.approved_and_sent}`);
  console.log(`    ❌  Rejected:                    ${counts.rejected}`);
  console.log(`    ⏭️   Skipped:                     ${counts.skipped}`);
  console.log(`    📊  Total drafts:                ${draftEntries.length}\n`);
  console.log("  ℹ️   No real WhatsApp messages were sent.");
  console.log(
    "      In production, approved messages would be dispatched via the"
  );
  console.log("      WhatsApp Business API after staff approval.\n");

  divider("═");
  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
