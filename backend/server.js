const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 5001);

const CITY_NAMES = [
  "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio", "San Diego", "Dallas", "San Jose",
  "Austin", "Jacksonville", "Fort Worth", "Columbus", "Charlotte", "San Francisco", "Indianapolis", "Seattle", "Denver", "Washington",
  "Boston", "El Paso", "Nashville", "Detroit", "Oklahoma City", "Portland", "Las Vegas", "Memphis", "Louisville", "Baltimore",
  "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Sacramento", "Kansas City", "Atlanta", "Miami", "Raleigh", "Omaha",
  "Long Beach", "Virginia Beach", "Oakland", "Minneapolis", "Tulsa", "Arlington", "Tampa", "New Orleans", "Wichita", "Cleveland",
  "Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa", "London", "Manchester", "Birmingham", "Paris", "Berlin",
  "Madrid", "Rome", "Lisbon", "Dublin", "Amsterdam", "Brussels", "Zurich", "Vienna", "Prague", "Warsaw",
  "Stockholm", "Oslo", "Helsinki", "Copenhagen", "Athens", "Istanbul", "Dubai", "Abu Dhabi", "Riyadh", "Doha",
  "Mumbai", "Delhi", "Bengaluru", "Chennai", "Hyderabad", "Kolkata", "Pune", "Ahmedabad", "Jaipur", "Lucknow",
  "Kochi", "Thiruvananthapuram", "Coimbatore", "Nagpur", "Surat", "Indore", "Patna", "Bhopal", "Singapore", "Tokyo",
  "Seoul", "Bangkok", "Jakarta", "Kuala Lumpur", "Manila", "Sydney", "Melbourne", "Brisbane", "Auckland", "Cape Town"
];

const cityLookup = new Map(CITY_NAMES.map((name) => [name.toLowerCase(), name]));

let tasks = [];
let volunteers = [];
let activityLog = [];
let emergencyMode = false;

const priorities = new Set(["low", "medium", "high"]);
const statuses = new Set(["pending", "assigned", "completed"]);

const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const logActivity = (type, message, meta = {}) => {
  activityLog.unshift({
    id: id("log"),
    type,
    message,
    timestamp: nowIso(),
    meta
  });

  if (activityLog.length > 250) {
    activityLog = activityLog.slice(0, 250);
  }
};

const normalizeString = (value) => (typeof value === "string" ? value.trim() : "");
const normalizeSkill = (skill) => normalizeString(skill).toLowerCase();

const isValidName = (name) => /^[A-Za-z ]+$/.test(normalizeString(name));
const normalizeLocation = (location) => {
  const value = normalizeString(location).toLowerCase();
  return cityLookup.get(value) || null;
};

const normalizeSkills = (skills) => {
  if (!Array.isArray(skills)) {
    return [];
  }

  return [...new Set(skills.map((skill) => normalizeString(skill)).filter(Boolean))];
};

const sanitizeVolunteer = (v) => ({
  id: v.id,
  name: v.name,
  skills: Array.isArray(v.skills) ? v.skills : [],
  location: v.location || "",
  status: v.status || "available",
  rating: Number.isFinite(v.rating) ? v.rating : 1,
  activeTaskIds: Array.isArray(v.activeTaskIds) ? v.activeTaskIds : [],
  createdAt: v.createdAt,
  updatedAt: v.updatedAt
});

const sanitizeTask = (t) => ({
  id: t.id,
  title: t.title || "",
  skill: t.skill || "",
  location: t.location || "",
  priority: t.priority || "low",
  status: statuses.has(t.status) ? t.status : "pending",
  assignedVolunteerId: t.assignedVolunteerId || null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt
});

const scoreVolunteerForTask = (task, volunteer) => {
  let score = 0;
  const reasoning = [];

  const volunteerSkillSet = new Set(volunteer.skills.map((skill) => normalizeSkill(skill)));
  if (volunteerSkillSet.has(normalizeSkill(task.skill))) {
    score += 50;
    reasoning.push("Skill match (+50)");
  }

  if (volunteer.location === task.location) {
    score += 20;
    reasoning.push("Same location (+20)");
  }

  if (volunteer.status === "available") {
    score += 20;
    reasoning.push("Available now (+20)");
  }

  score += volunteer.rating;
  reasoning.push(`Rating bonus (+${volunteer.rating})`);

  if (emergencyMode && task.priority === "high") {
    score += 30;
    reasoning.push("Emergency high-priority boost (+30)");
  }

  return {
    volunteerId: volunteer.id,
    volunteerName: volunteer.name,
    score,
    reasoning,
    volunteer: sanitizeVolunteer(volunteer)
  };
};

const getTaskMatches = (task) => {
  const sorted = volunteers
    .map((volunteer) => scoreVolunteerForTask(task, volunteer))
    .sort((a, b) => b.score - a.score || a.volunteerName.localeCompare(b.volunteerName));

  return {
    best: sorted[0] || null,
    top3: sorted.slice(0, 3)
  };
};

const assignVolunteerToTask = (task, volunteer, source = "manual") => {
  task.status = "assigned";
  task.assignedVolunteerId = volunteer.id;
  task.updatedAt = nowIso();

  volunteer.status = "busy";
  volunteer.activeTaskIds = [...new Set([...(volunteer.activeTaskIds || []), task.id])];
  volunteer.updatedAt = nowIso();

  logActivity(
    "TASK_ASSIGNED",
    `Task \"${task.title}\" assigned to ${volunteer.name} via ${source}.`,
    { taskId: task.id, volunteerId: volunteer.id, source }
  );
};

const completeTask = (task) => {
  task.status = "completed";
  task.updatedAt = nowIso();

  if (task.assignedVolunteerId) {
    const assignedVolunteer = volunteers.find((vol) => vol.id === task.assignedVolunteerId);
    if (assignedVolunteer) {
      assignedVolunteer.activeTaskIds = (assignedVolunteer.activeTaskIds || []).filter((taskId) => taskId !== task.id);
      if (assignedVolunteer.activeTaskIds.length === 0) {
        assignedVolunteer.status = "available";
      }
      assignedVolunteer.updatedAt = nowIso();
    }
  }

  logActivity("TASK_COMPLETED", `Task \"${task.title}\" marked as completed.`, { taskId: task.id });
};

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/api/health", (_, res) => {
  return res.json({
    ok: true,
    service: "Smart Emergency Volunteer Coordination System",
    timestamp: nowIso(),
    emergencyMode,
    totals: {
      tasks: tasks.length,
      volunteers: volunteers.length
    }
  });
});

app.get("/api/tasks", (_, res) => {
  res.json(tasks.map(sanitizeTask));
});

app.post("/api/tasks", (req, res) => {
  const title = normalizeString(req.body.title);
  const skill = normalizeString(req.body.skill);
  const location = normalizeString(req.body.location);
  const priority = normalizeString(req.body.priority || "low").toLowerCase();

  if (!title || !skill || !location || !priorities.has(priority)) {
    return res.status(400).json({
      message: "Valid title, skill, location, and priority (low/medium/high) are required."
    });
  }

  const task = {
    id: id("task"),
    title,
    skill,
    location,
    priority,
    status: "pending",
    assignedVolunteerId: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  tasks.unshift(task);
  logActivity("TASK_ADDED", `Task \"${task.title}\" created (${task.priority}).`, { taskId: task.id });

  return res.status(201).json(sanitizeTask(task));
});

app.post("/api/tasks/:taskId/assign", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  const volunteer = volunteers.find((entry) => entry.id === req.body.volunteerId);

  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  if (!volunteer) {
    return res.status(404).json({ message: "Volunteer not found." });
  }

  if (task.status === "completed") {
    return res.status(400).json({ message: "Completed tasks cannot be reassigned." });
  }

  assignVolunteerToTask(task, volunteer);
  return res.json({ message: "Task assigned successfully.", task: sanitizeTask(task) });
});

app.post("/api/tasks/:taskId/auto-assign", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  if (task.status === "completed") {
    return res.status(400).json({ message: "Completed tasks cannot be assigned." });
  }

  const { best } = getTaskMatches(task);
  if (!best) {
    return res.status(400).json({ message: "No volunteers available for matching." });
  }

  const volunteer = volunteers.find((entry) => entry.id === best.volunteerId);
  if (!volunteer) {
    return res.status(404).json({ message: "Matched volunteer no longer exists." });
  }

  assignVolunteerToTask(task, volunteer, "auto-assign");
  return res.json({
    message: "Task auto-assigned successfully.",
    task: sanitizeTask(task),
    assignedVolunteer: sanitizeVolunteer(volunteer),
    aiScore: best.score,
    reasoning: best.reasoning
  });
});

app.post("/api/tasks/auto-assign-pending", (_, res) => {
  const pendingTasks = tasks.filter((task) => task.status === "pending");
  let assignedCount = 0;
  const results = [];

  pendingTasks.forEach((task) => {
    const { best } = getTaskMatches(task);
    if (!best) {
      return;
    }

    const volunteer = volunteers.find((entry) => entry.id === best.volunteerId);
    if (!volunteer) {
      return;
    }

    assignVolunteerToTask(task, volunteer, "bulk-auto-assign");
    assignedCount += 1;
    results.push({
      taskId: task.id,
      taskTitle: task.title,
      volunteerId: volunteer.id,
      volunteerName: volunteer.name,
      aiScore: best.score
    });
  });

  logActivity("BULK_AUTO_ASSIGN", `Bulk auto-assign executed. ${assignedCount} tasks assigned.`, {
    assignedCount
  });

  return res.json({
    assignedCount,
    attempted: pendingTasks.length,
    results
  });
});

app.post("/api/tasks/:taskId/complete", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  if (task.status === "completed") {
    return res.json({ message: "Task already completed.", task: sanitizeTask(task) });
  }

  completeTask(task);
  return res.json({ message: "Task marked as completed.", task: sanitizeTask(task) });
});

app.delete("/api/tasks/completed", (_, res) => {
  const before = tasks.length;
  tasks = tasks.filter((task) => task.status !== "completed");
  const removed = before - tasks.length;

  logActivity("CLEAR_COMPLETED", `${removed} completed tasks cleared from board.`, { removed });

  return res.json({
    removed,
    remaining: tasks.length
  });
});

app.get("/api/volunteers", (_, res) => {
  res.json(volunteers.map(sanitizeVolunteer));
});

app.post("/api/volunteers", (req, res) => {
  const name = normalizeString(req.body.name);
  const skills = normalizeSkills(req.body.skills);
  const location = normalizeLocation(req.body.location);
  const rating = Number(req.body.rating);

  if (!isValidName(name)) {
    return res.status(400).json({ message: "Name must contain alphabets and spaces only." });
  }

  if (skills.length === 0) {
    return res.status(400).json({ message: "At least one skill is required." });
  }

  if (!location) {
    return res.status(400).json({ message: "Location must be a real city name." });
  }

  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }

  const volunteer = {
    id: id("vol"),
    name,
    skills,
    location,
    status: "available",
    rating,
    activeTaskIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  volunteers.unshift(volunteer);
  logActivity("VOLUNTEER_ADDED", `Volunteer ${volunteer.name} added (${volunteer.location}).`, {
    volunteerId: volunteer.id
  });

  return res.status(201).json(sanitizeVolunteer(volunteer));
});

app.post("/api/match", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.body.taskId);
  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  const { best, top3 } = getTaskMatches(task);
  if (!best) {
    return res.json({
      task: sanitizeTask(task),
      bestVolunteer: null,
      bestScore: 0,
      detailedReasoning: ["No volunteers are currently registered."],
      topMatches: []
    });
  }

  return res.json({
    task: sanitizeTask(task),
    bestVolunteer: best.volunteer,
    bestScore: best.score,
    detailedReasoning: best.reasoning,
    topMatches: top3.map((entry) => ({
      volunteer: entry.volunteer,
      score: entry.score,
      reasoning: entry.reasoning
    }))
  });
});

app.get("/api/suggestions/:taskId", (req, res) => {
  const task = tasks.find((entry) => entry.id === req.params.taskId);
  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  const { top3 } = getTaskMatches(task);
  return res.json({
    task: sanitizeTask(task),
    suggestions: top3.map((entry) => ({
      volunteer: entry.volunteer,
      score: entry.score,
      reasoning: entry.reasoning
    }))
  });
});

app.get("/api/dashboard", (_, res) => {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const highPriorityCount = tasks.filter((task) => task.priority === "high").length;
  const efficiency = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return res.json({
    totalTasks,
    completedTasks,
    volunteersCount: volunteers.length,
    efficiency,
    highPriorityCount,
    emergencyMode
  });
});

app.get("/api/activity", (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
  return res.json(activityLog.slice(0, limit));
});

app.get("/api/export", (_, res) => {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const highPriorityCount = tasks.filter((task) => task.priority === "high").length;
  const efficiency = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return res.json({
    exportedAt: nowIso(),
    emergencyMode,
    dashboard: {
      totalTasks,
      completedTasks,
      volunteersCount: volunteers.length,
      efficiency,
      highPriorityCount
    },
    tasks: tasks.map(sanitizeTask),
    volunteers: volunteers.map(sanitizeVolunteer),
    activity: activityLog
  });
});

app.get("/api/emergency", (_, res) => {
  res.json({ emergencyMode });
});

app.post("/api/emergency/toggle", (_, res) => {
  emergencyMode = !emergencyMode;
  logActivity(
    "EMERGENCY_MODE",
    emergencyMode ? "Emergency mode activated." : "Emergency mode deactivated.",
    { emergencyMode }
  );

  res.json({ emergencyMode });
});

app.get(/.*/, (_, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Smart Emergency Volunteer Coordination System running on http://localhost:${PORT}`);
});