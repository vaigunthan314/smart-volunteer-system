const http = require("http");

const BASE_URL = "http://localhost:5001";

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;

    const req = http.request(
      `${BASE_URL}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data ? data.length : 0
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          const payload = raw ? JSON.parse(raw) : {};
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${payload.message || raw}`));
            return;
          }
          resolve(payload);
        });
      }
    );

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  try {
    const volunteer = await request("POST", "/api/volunteers", {
      name: "Alicia Hart",
      skills: ["first aid", "rescue"],
      location: "New York",
      rating: 5
    });

    const task = await request("POST", "/api/tasks", {
      title: "Assist Flooded Area",
      skill: "first aid",
      location: "New York",
      priority: "high"
    });

    const match = await request("POST", "/api/match", { taskId: task.id });
    if (!match.bestVolunteer || !Array.isArray(match.topMatches) || match.topMatches.length === 0) {
      throw new Error("Match engine returned invalid response.");
    }

    const autoAssign = await request("POST", `/api/tasks/${task.id}/auto-assign`);
    if (!autoAssign.assignedVolunteer || autoAssign.task.status !== "assigned") {
      throw new Error("Auto-assign failed.");
    }

    const completed = await request("POST", `/api/tasks/${task.id}/complete`);
    if (completed.task.status !== "completed") {
      throw new Error("Complete task failed.");
    }

    const dashboard = await request("GET", "/api/dashboard");
    if (!Number.isInteger(dashboard.totalTasks)) {
      throw new Error("Dashboard response malformed.");
    }

    console.log("✅ Smoke test passed.");
  } catch (error) {
    console.error("❌ Smoke test failed:", error.message);
    process.exitCode = 1;
  }
})();
