const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../src/db");
const { createApp, addFallbacks } = require("../src/app");

let server, base, db;
const silentLogger = { error() { }, log() { } };
const TODAY = "2026-12-10"; // fixed "today" so tests never depend on the real date

before(async () => {
    db = openDb(":memory:");
    const app = addFallbacks(createApp(db, { today: () => TODAY, logger: silentLogger }), { logger: silentLogger });
    await new Promise((resolve) => (server = app.listen(0, resolve)));
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
        name: "Asha Verma",
        phone: "+91 98765 43210",
        consultation_date: "2026-12-01",
        next_follow_up_date: TODAY,
        ...overrides,
    });

test("adds a patient and returns 201 with pending status", async () => {
    const res = await addPatient();
    assert.equal(res.status, 201);
    assert.equal(res.body.follow_up_status, "pending");
    assert.equal(res.body.phone, "+919876543210");
});

test("rejects missing and invalid fields with 400", async () => {
    const empty = await call("POST", "/patients", {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.details.length, 4);
    assert.equal((await addPatient({ phone: "abc" })).status, 400);
    assert.equal((await addPatient({ consultation_date: "2026-02-31" })).status, 400);
    assert.equal((await addPatient({ next_follow_up_date: "10-12-2026" })).status, 400);
    const before = await addPatient({ consultation_date: "2026-12-05", next_follow_up_date: "2026-12-01" });
    assert.equal(before.status, 400);
    assert.match(before.body.details[0], /before consultation_date/);
});

test("returns 400 for invalid JSON", async () => {
    const res = await fetch(base + "/patients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{oops",
    });
    assert.equal(res.status, 400);
});

test("retrieves all patients and a single patient", async () => {
    const created = (await addPatient({ name: "Meera Nair" })).body;
    const all = await call("GET", "/patients");
    assert.equal(all.status, 200);
    assert.ok(all.body.some((p) => p.id === created.id));
    const one = await call("GET", `/patients/${created.id}`);
    assert.equal(one.body.name, "Meera Nair");
});

test("404 for unknown patient, 400 for malformed id", async () => {
    assert.equal((await call("GET", "/patients/99999")).status, 404);
    assert.equal((await call("GET", "/patients/abc")).status, 400);
    assert.equal((await call("PATCH", "/patients/99999/follow-up", { status: "completed" })).status, 404);
});

test("due-today returns only pending follow-ups for today", async () => {
    const dueToday = (await addPatient({ name: "Due Today" })).body;
    const future = (await addPatient({ name: "Future", next_follow_up_date: "2026-12-20" })).body;
    const overdue = (await addPatient({ name: "Overdue", consultation_date: "2026-11-01", next_follow_up_date: "2026-12-05" })).body;

    const res = await call("GET", "/patients/due-today");
    assert.equal(res.status, 200);
    assert.equal(res.body.date, TODAY);
    const ids = res.body.patients.map((p) => p.id);
    assert.ok(ids.includes(dueToday.id));
    assert.ok(!ids.includes(future.id));
    assert.ok(!ids.includes(overdue.id));

    const withOverdue = await call("GET", "/patients/due-today?include_overdue=true");
    assert.ok(withOverdue.body.patients.some((p) => p.id === overdue.id));

    const otherDay = await call("GET", "/patients/due-today?date=2026-12-20");
    assert.ok(otherDay.body.patients.some((p) => p.id === future.id));
    assert.equal((await call("GET", "/patients/due-today?date=nope")).status, 400);
});

test("marking follow-up completed removes patient from due-today", async () => {
    const p = (await addPatient({ name: "To Complete" })).body;
    const done = await call("PATCH", `/patients/${p.id}/follow-up`, { status: "completed" });
    assert.equal(done.status, 200);
    assert.equal(done.body.follow_up_status, "completed");
    assert.ok(done.body.completed_at);

    const due = await call("GET", "/patients/due-today");
    assert.ok(!due.body.patients.some((x) => x.id === p.id));

    const again = await call("PATCH", `/patients/${p.id}/follow-up`, { status: "completed" });
    assert.equal(again.status, 409);
});

test("rejects invalid follow-up status", async () => {
    const p = (await addPatient()).body;
    assert.equal((await call("PATCH", `/patients/${p.id}/follow-up`, { status: "done" })).status, 400);
    assert.equal((await call("PATCH", `/patients/${p.id}/follow-up`, {})).status, 400);
});

test("status filter on GET /patients", async () => {
    const pending = await call("GET", "/patients?status=pending");
    assert.ok(pending.body.every((p) => p.follow_up_status === "pending"));
    assert.equal((await call("GET", "/patients?status=wrong")).status, 400);
});

test("data persists after the database is closed and reopened", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "epia-")), "persist.db");
    const first = openDb(file);
    first
        .prepare("INSERT INTO patients (name, phone, consultation_date, next_follow_up_date) VALUES (?,?,?,?)")
        .run("Persist", "9876543210", "2026-12-01", "2026-12-08");
    first.close();
    const second = openDb(file);
    const row = second.prepare("SELECT name FROM patients WHERE id = 1").get();
    second.close();
    assert.equal(row.name, "Persist");
});