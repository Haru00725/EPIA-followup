const express = require("express");

// ---------- helpers ----------
const isPositiveInt = (v) => /^[1-9]\d{0,9}$/.test(String(v));

// True only for real calendar dates in YYYY-MM-DD form (rejects 2026-02-31).
function isRealDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function normalizePhone(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/[\s\-()]/g, "");
    return /^\+?\d{10,15}$/.test(cleaned) ? cleaned : null;
}

// Today's date in the server's local timezone, as YYYY-MM-DD.
function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function createApp(db, { today = todayLocal, logger = console } = {}) {
    const app = express();
    app.use(express.json({ limit: "100kb" }));

    const q = {
        insert: db.prepare(
            `INSERT INTO patients (name, phone, consultation_date, next_follow_up_date)
       VALUES (?, ?, ?, ?)`
        ),
        get: db.prepare("SELECT * FROM patients WHERE id = ?"),
        all: db.prepare("SELECT * FROM patients ORDER BY id"),
        allByStatus: db.prepare("SELECT * FROM patients WHERE follow_up_status = ? ORDER BY id"),
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
        complete: db.prepare(
            `UPDATE patients SET follow_up_status = 'completed', completed_at = datetime('now')
       WHERE id = ?`
        ),
        reopen: db.prepare(
            `UPDATE patients SET follow_up_status = 'pending', completed_at = NULL WHERE id = ?`
        ),
    };

    // POST /patients: add a patient
    app.post("/patients", (req, res) => {
        const { name, phone, consultation_date, next_follow_up_date } = req.body ?? {};
        const errors = [];

        if (typeof name !== "string" || name.trim() === "") errors.push("name is required");
        else if (name.trim().length > 100) errors.push("name must be 100 characters or fewer");

        const cleanPhone = normalizePhone(phone);
        if (phone === undefined || phone === "") errors.push("phone is required");
        else if (!cleanPhone) errors.push("phone must be 10-15 digits, optionally starting with +");

        const consultOk = isRealDate(consultation_date);
        if (consultation_date === undefined || consultation_date === "")
            errors.push("consultation_date is required");
        else if (!consultOk) errors.push("consultation_date must be a valid date (YYYY-MM-DD)");

        const followOk = isRealDate(next_follow_up_date);
        if (next_follow_up_date === undefined || next_follow_up_date === "")
            errors.push("next_follow_up_date is required");
        else if (!followOk) errors.push("next_follow_up_date must be a valid date (YYYY-MM-DD)");

        if (consultOk && followOk && next_follow_up_date < consultation_date)
            errors.push("next_follow_up_date cannot be before consultation_date");

        if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

        const info = q.insert.run(name.trim(), cleanPhone, consultation_date, next_follow_up_date);
        res.status(201).json(q.get.get(info.lastInsertRowid));
    });

    // GET /patients: all patients (optional ?status=pending|completed)
    app.get("/patients", (req, res) => {
        const { status } = req.query;
        if (status === undefined) return res.json(q.all.all());
        if (!["pending", "completed"].includes(status))
            return res.status(400).json({ error: "status must be 'pending' or 'completed'" });
        res.json(q.allByStatus.all(status));
    });

    // GET /patients/due-today: pending follow-ups due today
    //   ?include_overdue=true  also includes earlier pending follow-ups
    //   ?date=YYYY-MM-DD       checks another day (handy for testing and demos)
    app.get("/patients/due-today", (req, res) => {
        const { date, include_overdue } = req.query;
        if (date !== undefined && !isRealDate(date))
            return res.status(400).json({ error: "date must be a valid date (YYYY-MM-DD)" });
        if (include_overdue !== undefined && !["true", "false"].includes(include_overdue))
            return res.status(400).json({ error: "include_overdue must be 'true' or 'false'" });

        const day = date ?? today();
        const rows =
            include_overdue === "true" ? q.dueOnOrBefore.all(day) : q.dueOn.all(day);
        res.json({ date: day, count: rows.length, patients: rows });
    });

    // GET /patients/:id
    app.get("/patients/:id", (req, res) => {
        if (!isPositiveInt(req.params.id))
            return res.status(400).json({ error: "id must be a positive integer" });
        const patient = q.get.get(Number(req.params.id));
        if (!patient) return res.status(404).json({ error: "Patient not found" });
        res.json(patient);
    });

    // PATCH /patients/:id/follow-up: update follow-up status, body {"status":"completed"}
    app.patch("/patients/:id/follow-up", (req, res) => {
        if (!isPositiveInt(req.params.id))
            return res.status(400).json({ error: "id must be a positive integer" });

        const { status } = req.body ?? {};
        if (!["pending", "completed"].includes(status))
            return res.status(400).json({ error: "status must be 'pending' or 'completed'" });

        const patient = q.get.get(Number(req.params.id));
        if (!patient) return res.status(404).json({ error: "Patient not found" });
        if (patient.follow_up_status === status)
            return res.status(409).json({ error: `Follow-up is already ${status}` });

        (status === "completed" ? q.complete : q.reopen).run(patient.id);
        res.json(q.get.get(patient.id));
    });

    return app;
}

/**
 * Adds catch-all 404 and error-handling middleware.
 * Call this AFTER all routes (Task 1 + Task 2) have been registered.
 */
function addFallbacks(app, { logger = console } = {}) {
    app.use((req, res) => res.status(404).json({ error: "Route not found" }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err.type === "entity.parse.failed")
            return res.status(400).json({ error: "Request body is not valid JSON" });
        logger.error(JSON.stringify({ event: "unhandled_error", message: err.message }));
        res.status(500).json({ error: "Internal server error" });
    });

    return app;
}

module.exports = { createApp, addFallbacks };