const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(cors());
app.use(express.json());

// Required simple test route
app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

const PRIORITIES = new Set(["low", "medium", "high"]);
const TASK_STATUSES = new Set(["pending", "assigned", "completed"]);

let tasks = [];
let volunteers = [];
let activity = [];
let emergencyMode = false;

const now = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const clean = (value) => (typeof value === "string" ? value.trim() : "");

function logEvent(type, message, meta = {}) {
  activity.unshift({
    id: makeId("log"),
    type,
    message,
    meta,
    timestamp: now()
  });

  if (activity.length > 250) {
    activity = activity.slice(0, 250);
  }
}

function sanitizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    skill: task.skill,
    location: task.location,
    priority: task.priority,
    status: TASK_STATUSES.has(task.status) ? task.status : "pending",
    assignedVolunteerId: task.assignedVolunteerId || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function sanitizeVolunteer(volunteer) {
  return {
    id: volunteer.id,
    name: volunteer.name,
    skills: Array.isArray(volunteer.skills) ? volunteer.skills : [],
    location: volunteer.location,
    status: volunteer.status || "available",
    rating: Number(volunteer.rating) || 1,
    activeTaskIds: Array.isArray(volunteer.activeTaskIds) ? volunteer.activeTaskIds : [],
    createdAt: volunteer.createdAt,
    updatedAt: volunteer.updatedAt
  };
}

function computeVolunteerScore(task, volunteer) {
  let score = 0;
  const reasoning = [];

  const volunteerSkills = new Set((volunteer.skills || []).map((s) => clean(s).toLowerCase()));
  const taskSkill = clean(task.skill).toLowerCase();

  if (volunteerSkills.has(taskSkill)) {
    score += 50;
    reasoning.push("Skill match (+50)");
  }

  if (clean(volunteer.location).toLowerCase() === clean(task.location).toLowerCase()) {
    score += 20;
    reasoning.push("Same location (+20)");
  }

  if (volunteer.status === "available") {
    score += 20;
    reasoning.push("Availability (+20)");
  }

  const ratingBoost = Number(volunteer.rating) || 0;
  score += ratingBoost;
  reasoning.push(`Rating (+${ratingBoost})`);

  if (emergencyMode && task.priority === "high") {
    score += 30;
    reasoning.push("Emergency boost (+30)");
  }

  return {
    volunteer,
    score,
    reasoning
  };
}

function getTaskMatches(task) {
  return volunteers
    .map((volunteer) => computeVolunteerScore(task, volunteer))
    .sort((a, b) => b.score - a.score || a.volunteer.name.localeCompare(b.volunteer.name));
}

function assignVolunteer(task, volunteer, source = "manual") {
  task.status = "assigned";
  task.assignedVolunteerId = volunteer.id;
  task.updatedAt = now();

  volunteer.status = "busy";
  volunteer.activeTaskIds = [...new Set([...(volunteer.activeTaskIds || []), task.id])];
  volunteer.updatedAt = now();

  logEvent("TASK_ASSIGNED", `Task \"${task.title}\" assigned to ${volunteer.name}.`, {
    taskId: task.id,
    volunteerId: volunteer.id,
    source
  });
}

function releaseVolunteerForTask(task) {
  if (!task.assignedVolunteerId) return;

  const volunteer = volunteers.find((v) => v.id === task.assignedVolunteerId);
  if (!volunteer) return;

  volunteer.activeTaskIds = (volunteer.activeTaskIds || []).filter((taskId) => taskId !== task.id);
  if (volunteer.activeTaskIds.length === 0) {
    volunteer.status = "available";
  }
  volunteer.updatedAt = now();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    emergencyMode,
    totals: {
      tasks: tasks.length,
      volunteers: volunteers.length
    },
    timestamp: now()
  });
});

app.get("/api/tasks", (_req, res) => {
  res.json(tasks.map(sanitizeTask));
});

app.post("/api/tasks", (req, res) => {
  const title = clean(req.body.title);
  const skill = clean(req.body.skill);
  const location = clean(req.body.location);
  const priority = clean(req.body.priority || "low").toLowerCase();

  if (!title || !skill || !location || !PRIORITIES.has(priority)) {
    return res.status(400).json({ message: "Valid title, skill, location and priority are required." });
  }

  const task = {
    id: makeId("task"),
    title,
    skill,
    location,
    priority,
    status: "pending",
    assignedVolunteerId: null,
    createdAt: now(),
    updatedAt: now()
  };

  tasks.unshift(task);
  logEvent("TASK_ADDED", `Task \"${task.title}\" created.`, { taskId: task.id });
  res.status(201).json(sanitizeTask(task));
});

app.post("/api/tasks/:taskId/assign", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  const volunteer = volunteers.find((entry) => entry.id === req.body.volunteerId);

  if (!task) return res.status(404).json({ message: "Task not found." });
  if (!volunteer) return res.status(404).json({ message: "Volunteer not found." });
  if (task.status === "completed") return res.status(400).json({ message: "Completed task cannot be assigned." });

  assignVolunteer(task, volunteer);
  res.json({ message: "Task assigned.", task: sanitizeTask(task) });
});

app.post("/api/tasks/:taskId/auto-assign", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  if (!task) return res.status(404).json({ message: "Task not found." });

  const matches = getTaskMatches(task);
  const best = matches[0];

  if (!best) {
    return res.status(400).json({ message: "No volunteers available for matching." });
  }

  assignVolunteer(task, best.volunteer, "auto");
  res.json({
    message: "Task auto-assigned.",
    task: sanitizeTask(task),
    assignedVolunteer: sanitizeVolunteer(best.volunteer),
    aiScore: best.score,
    reasoning: best.reasoning
  });
});

app.post("/api/tasks/auto-assign-pending", (_req, res) => {
  const pending = tasks.filter((task) => task.status === "pending");
  let assignedCount = 0;
  const results = [];

  pending.forEach((task) => {
    const best = getTaskMatches(task)[0];
    if (!best) return;

    assignVolunteer(task, best.volunteer, "bulk-auto");
    assignedCount += 1;
    results.push({
      taskId: task.id,
      taskTitle: task.title,
      volunteerId: best.volunteer.id,
      volunteerName: best.volunteer.name,
      aiScore: best.score
    });
  });

  logEvent("BULK_AUTO_ASSIGN", `Bulk auto-assigned ${assignedCount} tasks.`, { assignedCount });
  res.json({ assignedCount, attempted: pending.length, results });
});

app.post("/api/tasks/:taskId/complete", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  if (!task) return res.status(404).json({ message: "Task not found." });

  task.status = "completed";
  task.updatedAt = now();
  releaseVolunteerForTask(task);
  logEvent("TASK_COMPLETED", `Task \"${task.title}\" completed.`, { taskId: task.id });

  res.json({ message: "Task completed.", task: sanitizeTask(task) });
});

app.delete("/api/tasks/:taskId", (req, res) => {
  const index = tasks.findIndex((entry) => entry.id === req.params.taskId);
  if (index < 0) return res.status(404).json({ message: "Task not found." });

  const [removed] = tasks.splice(index, 1);
  releaseVolunteerForTask(removed);
  logEvent("TASK_DELETED", `Task \"${removed.title}\" deleted.`, { taskId: removed.id });

  res.json({ message: "Task deleted." });
});

app.delete("/api/tasks/completed", (_req, res) => {
  const before = tasks.length;
  tasks = tasks.filter((task) => task.status !== "completed");
  const removed = before - tasks.length;

  logEvent("CLEAR_COMPLETED", `Cleared ${removed} completed tasks.`, { removed });
  res.json({ removed, remaining: tasks.length });
});

app.get("/api/volunteers", (_req, res) => {
  res.json(volunteers.map(sanitizeVolunteer));
});

app.post("/api/volunteers", (req, res) => {
  const name = clean(req.body.name);
  const skills = Array.isArray(req.body.skills)
    ? req.body.skills.map((item) => clean(item)).filter(Boolean)
    : [];
  const location = clean(req.body.location);
  const rating = Number(req.body.rating);

  if (!name || !/^[A-Za-z ]+$/.test(name)) {
    return res.status(400).json({ message: "Name must contain alphabets and spaces only." });
  }
  if (!skills.length) {
    return res.status(400).json({ message: "At least one skill is required." });
  }
  if (!location) {
    return res.status(400).json({ message: "Location is required." });
  }
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }

  const volunteer = {
    id: makeId("vol"),
    name,
    skills,
    location,
    status: "available",
    rating,
    activeTaskIds: [],
    createdAt: now(),
    updatedAt: now()
  };

  volunteers.unshift(volunteer);
  logEvent("VOLUNTEER_ADDED", `Volunteer ${volunteer.name} added.`, { volunteerId: volunteer.id });

  res.status(201).json(sanitizeVolunteer(volunteer));
});

app.put("/api/volunteers/:volunteerId", (req, res) => {
  const volunteer = volunteers.find((entry) => entry.id === req.params.volunteerId);
  if (!volunteer) return res.status(404).json({ message: "Volunteer not found." });

  const name = clean(req.body.name);
  const skills = Array.isArray(req.body.skills)
    ? req.body.skills.map((item) => clean(item)).filter(Boolean)
    : [];
  const location = clean(req.body.location);
  const rating = Number(req.body.rating);

  if (!name || !/^[A-Za-z ]+$/.test(name)) {
    return res.status(400).json({ message: "Name must contain alphabets and spaces only." });
  }
  if (!skills.length) {
    return res.status(400).json({ message: "At least one skill is required." });
  }
  if (!location) {
    return res.status(400).json({ message: "Location is required." });
  }
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }

  volunteer.name = name;
  volunteer.skills = skills;
  volunteer.location = location;
  volunteer.rating = rating;
  volunteer.updatedAt = now();

  logEvent("VOLUNTEER_UPDATED", `Volunteer ${volunteer.name} updated.`, { volunteerId: volunteer.id });
  res.json(sanitizeVolunteer(volunteer));
});

app.delete("/api/volunteers/:volunteerId", (req, res) => {
  const index = volunteers.findIndex((entry) => entry.id === req.params.volunteerId);
  if (index < 0) return res.status(404).json({ message: "Volunteer not found." });

  const [removed] = volunteers.splice(index, 1);

  tasks = tasks.map((task) => {
    if (task.assignedVolunteerId !== removed.id) return task;
    return {
      ...task,
      status: task.status === "completed" ? "completed" : "pending",
      assignedVolunteerId: null,
      updatedAt: now()
    };
  });

  logEvent("VOLUNTEER_DELETED", `Volunteer ${removed.name} deleted.`, { volunteerId: removed.id });
  res.json({ message: "Volunteer deleted." });
});

app.post("/api/match", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.body.taskId);
  if (!task) return res.status(404).json({ message: "Task not found." });

  const matches = getTaskMatches(task);
  const best = matches[0];

  if (!best) {
    return res.json({
      task: sanitizeTask(task),
      bestVolunteer: null,
      bestScore: 0,
      detailedReasoning: ["No volunteers are currently registered."],
      topMatches: []
    });
  }

  res.json({
    task: sanitizeTask(task),
    bestVolunteer: sanitizeVolunteer(best.volunteer),
    bestScore: best.score,
    detailedReasoning: best.reasoning,
    topMatches: matches.slice(0, 3).map((entry) => ({
      volunteer: sanitizeVolunteer(entry.volunteer),
      score: entry.score,
      reasoning: entry.reasoning
    }))
  });
});

app.get("/api/suggestions/:taskId", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  if (!task) return res.status(404).json({ message: "Task not found." });

  const top3 = getTaskMatches(task).slice(0, 3);
  res.json({
    task: sanitizeTask(task),
    suggestions: top3.map((entry) => ({
      volunteer: sanitizeVolunteer(entry.volunteer),
      score: entry.score,
      reasoning: entry.reasoning
    }))
  });
});

app.get("/api/dashboard", (_req, res) => {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const highPriorityCount = tasks.filter((task) => task.priority === "high").length;

  res.json({
    totalTasks,
    completedTasks,
    volunteersCount: volunteers.length,
    efficiency: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
    highPriorityCount,
    emergencyMode
  });
});

app.get("/api/activity", (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
  res.json(activity.slice(0, limit));
});

app.get("/api/export", (_req, res) => {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const highPriorityCount = tasks.filter((task) => task.priority === "high").length;

  res.json({
    exportedAt: now(),
    emergencyMode,
    dashboard: {
      totalTasks,
      completedTasks,
      volunteersCount: volunteers.length,
      efficiency: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
      highPriorityCount
    },
    tasks: tasks.map(sanitizeTask),
    volunteers: volunteers.map(sanitizeVolunteer),
    activity
  });
});

app.get("/api/emergency", (_req, res) => {
  res.json({ emergencyMode });
});

app.post("/api/emergency/toggle", (_req, res) => {
  emergencyMode = !emergencyMode;
  logEvent("EMERGENCY_MODE", emergencyMode ? "Emergency mode activated." : "Emergency mode deactivated.", {
    emergencyMode
  });
  res.json({ emergencyMode });
});

// Optional static serving (UI still loads independently on GitHub Pages)
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.use(express.static(path.join(__dirname)));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});