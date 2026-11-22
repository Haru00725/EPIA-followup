const { openDb } = require("./db");
const { createApp, addFallbacks } = require("./app");
const { addFollowUpRoutes } = require("./ai-followup");

const PORT = process.env.PORT || 3000;
const db = openDb();

// Today helper (shared between Task 1 and Task 2 routes)
function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// AI configuration — set OPENAI_API_KEY to use a real AI model
const aiConfig = process.env.OPENAI_API_KEY
    ? {
          apiKey: process.env.OPENAI_API_KEY,
          apiBase: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
          model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      }
    : null;

let app = createApp(db);

// Add Task 2 follow-up automation routes
addFollowUpRoutes(app, db, { today: todayLocal, aiConfig });

// Add catch-all 404 and error handling (must come last)
addFallbacks(app);

process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({ event: "unhandled_rejection", message: String(reason) }));
});

const server = app.listen(PORT, () =>
    console.log(`Patient follow-up API listening on port ${PORT}`)
);

function shutdown() {
    server.close(() => {
        db.close();
        process.exit(0);
    });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);