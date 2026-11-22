const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/db");
const { createApp, addFallbacks } = require("../src/app");
const { addFollowUpRoutes, mockGenerateDraft } = require("../src/ai-followup");

let server, base, db, appInstance;
const silentLogger = { error() {}, log() {} };
const TODAY = "2026-12-10";

before(async () => {
  db = openDb(":memory:");
  appInstance = createApp(db, { today: () => TODAY, logger: silentLogger });
  addFollowUpRoutes(appInstance, db, {
    today: () => TODAY,
    aiConfig: null, // force mock
    logger: silentLogger,
  });
  addFallbacks(appInstance, { logger: silentLogger });
  await new Promise((resolve) => (server = appInstance.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const addPatient = (overrides = {}) =>
  call("POST", "/patients", {
    name: "Test Patient",
    phone: "+919876543210",
    consultation_date: "2026-12-01",
    next_follow_up_date: TODAY,
    ...overrides,
  });

// ── mockGenerateDraft unit tests ────────────────────────────

test("mock draft includes patient first name and dates", () => {
  const patient = {
    name: "Asha Verma",
    phone: "+919876543210",
    consultation_date: "2026-12-01",
    next_follow_up_date: "2026-12-10",
  };
  const draft = mockGenerateDraft(patient, "2026-12-10");
  assert.ok(draft.includes("Asha"), "draft should include first name");
  assert.ok(draft.includes("2026-12-01"), "draft should include consultation date");
  assert.ok(draft.includes("2026-12-10"), "draft should include follow-up date");
});

test("mock draft handles overdue patients differently", () => {
  const patient = {
    name: "Rahul Singh",
    phone: "+919123456789",
    consultation_date: "2026-11-01",
    next_follow_up_date: "2026-12-05",
  };
  const draft = mockGenerateDraft(patient, "2026-12-10");
  assert.ok(draft.includes("Rahul"), "draft should include first name");
  assert.ok(
    draft.toLowerCase().includes("reminder") || draft.toLowerCase().includes("reschedule"),
    "overdue draft should mention rescheduling"
  );
});

// ── API endpoint tests ──────────────────────────────────────

test("POST /followups/generate-drafts creates drafts for due patients", async () => {
  await addPatient({ name: "AI Due Patient" });

  const res = await call("POST", "/followups/generate-drafts");
  assert.equal(res.status, 200);
  assert.ok(res.body.drafts.length > 0, "should have at least one draft");
  assert.equal(res.body.drafts[0].source, "mock");
  assert.equal(res.body.drafts[0].status, "pending_review");
  assert.ok(res.body.drafts[0].draft.length > 0, "draft text should not be empty");
});

test("GET /followups/drafts returns generated drafts", async () => {
  const res = await call("GET", "/followups/drafts");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
});

test("GET /followups/drafts?status=pending_review filters correctly", async () => {
  const res = await call("GET", "/followups/drafts?status=pending_review");
  assert.equal(res.status, 200);
  assert.ok(res.body.every((d) => d.status === "pending_review"));
});

test("PATCH draft with action=edit updates the draft text", async () => {
  const all = await call("GET", "/followups/drafts?status=pending_review");
  const draftId = all.body[0]?.draftId;
  assert.ok(draftId, "need a pending draft to test edit");

  const res = await call("PATCH", `/followups/drafts/${draftId}`, {
    action: "edit",
    draft: "Updated message text for the patient.",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.draft, "Updated message text for the patient.");
  assert.ok(res.body.editedAt);
});

test("PATCH draft with action=approve simulates send and marks completed", async () => {
  // Add a fresh patient and generate a draft
  const patient = (await addPatient({ name: "Approve Test" })).body;
  await call("POST", "/followups/generate-drafts");

  const allDrafts = await call("GET", "/followups/drafts?status=pending_review");
  assert.ok(Array.isArray(allDrafts.body), "drafts response should be an array");
  const draft = allDrafts.body.find((d) => d.patientId === patient.id);
  assert.ok(draft, "should have a pending draft for the new patient");

  const res = await call("PATCH", `/followups/drafts/${draft.draftId}`, {
    action: "approve",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "sent");
  assert.ok(res.body.sentNote.includes("SIMULATED"));

  // Patient should now be completed
  const p = await call("GET", `/patients/${patient.id}`);
  assert.equal(p.body.follow_up_status, "completed");
});

test("PATCH draft with action=reject marks it rejected", async () => {
  await addPatient({ name: "Reject Test" });
  await call("POST", "/followups/generate-drafts");

  const allDrafts = await call("GET", "/followups/drafts?status=pending_review");
  assert.ok(Array.isArray(allDrafts.body));
  const draft = allDrafts.body[0];
  assert.ok(draft, "need a pending draft to test reject");

  const res = await call("PATCH", `/followups/drafts/${draft.draftId}`, {
    action: "reject",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "rejected");
});

test("cannot approve an already-sent draft (409)", async () => {
  // Create a fresh patient, generate draft, approve it, then try again
  const patient = (await addPatient({ name: "Double Approve" })).body;
  await call("POST", "/followups/generate-drafts");

  const allDrafts = await call("GET", "/followups/drafts?status=pending_review");
  const draft = allDrafts.body.find((d) => d.patientId === patient.id);
  assert.ok(draft, "need a pending draft");

  // First approve
  await call("PATCH", `/followups/drafts/${draft.draftId}`, { action: "approve" });

  // Second approve should fail
  const res = await call("PATCH", `/followups/drafts/${draft.draftId}`, {
    action: "approve",
  });
  assert.equal(res.status, 409);
});

test("returns 404 for unknown draft id", async () => {
  const res = await call("PATCH", "/followups/drafts/nonexistent-id", {
    action: "approve",
  });
  assert.equal(res.status, 404);
});

test("returns 400 for invalid action", async () => {
  await addPatient({ name: "Invalid Action" });
  await call("POST", "/followups/generate-drafts");

  const allDrafts = await call("GET", "/followups/drafts?status=pending_review");
  const draft = allDrafts.body[0];
  assert.ok(draft, "need a pending draft");

  const res = await call("PATCH", `/followups/drafts/${draft.draftId}`, {
    action: "invalid",
  });
  assert.equal(res.status, 400);
});

test("generate-drafts with no due patients returns empty array", async () => {
  const res = await call("POST", "/followups/generate-drafts?date=2099-01-01");
  assert.equal(res.status, 200);
  assert.equal(res.body.drafts.length, 0);
  assert.ok(res.body.message.includes("No follow-ups due"));
});
