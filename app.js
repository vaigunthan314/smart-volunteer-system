const API_CANDIDATES = (() => {
  const candidates = [];
  const origin = window.location.origin;

  candidates.push("https://smart-volunteer-system-final-1.onrender.com/api");
candidates.push("http://localhost:5000/api");

  candidates.push("http://localhost:5001/api");
  candidates.push("http://127.0.0.1:5001/api");

  return [...new Set(candidates)];
})();

const state = {
  tasks: [],
  volunteers: [],
  dashboard: {
    totalTasks: 0,
    completedTasks: 0,
    volunteersCount: 0,
    efficiency: 0,
    highPriorityCount: 0,
    emergencyMode: false
  },
  activity: [],
  emergencyMode: false,
  aiSelectionTaskId: "",
  apiBase: API_CANDIDATES[0],
  offlineMode: false,
  ui: {
    taskSearch: "",
    taskFilterPriority: "all",
    taskFilterStatus: "all",
    theme: localStorage.getItem("sevs_theme") || "aurora",
    editingVolunteerIndex: null,
    editingVolunteerId: null,
    highlightedVolunteerId: null,
    highlightedTaskId: null,
    isSavingTask: false,
    isSavingVolunteer: false
  }
};

let sirenTimer = null;
let audioCtx = null;
let sirenStopTimeout = null;
let emergencyPulseTimeout = null;
const EMERGENCY_PULSE_MS = 4000;

const OFFLINE_DB_KEY = "sevs_offline_db_v1";
const metricCache = {
  totalTasks: 0,
  completedTasks: 0,
  volunteersCount: 0,
  efficiency: 0,
  highPriorityCount: 0
};

const byId = (id) => document.getElementById(id);
const safe = (value, fallback = "") => (value === undefined || value === null ? fallback : value);

const toTitleCase = (value) =>
  String(safe(value))
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const byPriority = {
  high: 3,
  medium: 2,
  low: 1
};

function dedupeById(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const result = [];

  list.forEach((item) => {
    const key = item?.id || item?._id || JSON.stringify(item);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(item);
  });

  return result;
}

const createEmptyOfflineDb = () => ({
  tasks: [],
  volunteers: [],
  activity: [],
  emergencyMode: false
});

const readOfflineDb = () => {
  try {
    const raw = localStorage.getItem(OFFLINE_DB_KEY);
    if (!raw) return createEmptyOfflineDb();
    const parsed = JSON.parse(raw);
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      volunteers: Array.isArray(parsed.volunteers) ? parsed.volunteers : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      emergencyMode: Boolean(parsed.emergencyMode)
    };
  } catch {
    return createEmptyOfflineDb();
  }
};

let offlineDb = readOfflineDb();

const persistOfflineDb = () => {
  localStorage.setItem(OFFLINE_DB_KEY, JSON.stringify(offlineDb));
};

const offlineNowIso = () => new Date().toISOString();
const offlineId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const getOfflineDashboard = () => {
  const totalTasks = offlineDb.tasks.length;
  const completedTasks = offlineDb.tasks.filter((task) => task.status === "completed").length;
  const highPriorityCount = offlineDb.tasks.filter((task) => task.priority === "high").length;
  const volunteersCount = offlineDb.volunteers.length;

  return {
    totalTasks,
    completedTasks,
    volunteersCount,
    efficiency: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    highPriorityCount,
    emergencyMode: offlineDb.emergencyMode
  };
};

const appendOfflineActivity = (type, message, meta = {}) => {
  offlineDb.activity.unshift({
    id: offlineId("log"),
    type,
    message,
    timestamp: offlineNowIso(),
    meta
  });
  if (offlineDb.activity.length > 250) {
    offlineDb.activity = offlineDb.activity.slice(0, 250);
  }
};

const computeOfflineMatches = (task) => {
  const taskSkill = String(task.skill || "").toLowerCase();
  const sorted = offlineDb.volunteers
    .map((volunteer) => {
      let score = 0;
      const reasoning = [];
      const skills = Array.isArray(volunteer.skills) ? volunteer.skills.map((item) => String(item).toLowerCase()) : [];

      if (skills.includes(taskSkill)) {
        score += 50;
        reasoning.push("Skill match (+50)");
      }
      if (volunteer.location === task.location) {
        score += 20;
        reasoning.push("Same location (+20)");
      }
      if (volunteer.status === "available") {
        score += 20;
        reasoning.push("Availability (+20)");
      }
      score += Number(volunteer.rating || 0);
      reasoning.push(`Rating (+${Number(volunteer.rating || 0)})`);
      if (offlineDb.emergencyMode && task.priority === "high") {
        score += 30;
        reasoning.push("Emergency priority boost (+30)");
      }

      return { volunteer, score, reasoning };
    })
    .sort((a, b) => b.score - a.score || a.volunteer.name.localeCompare(b.volunteer.name));

  return {
    best: sorted[0] || null,
    top3: sorted.slice(0, 3)
  };
};

async function localApiRequest(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const url = new URL(path, "http://offline.local");
  const pathname = url.pathname;
  const parts = pathname.split("/").filter(Boolean);

  if (pathname === "/tasks" && method === "GET") return offlineDb.tasks;
  if (pathname === "/volunteers" && method === "GET") return offlineDb.volunteers;
  if (pathname === "/dashboard" && method === "GET") return getOfflineDashboard();
  if (pathname === "/activity" && method === "GET") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 24)));
    return offlineDb.activity.slice(0, limit);
  }
  if (pathname === "/emergency" && method === "GET") return { emergencyMode: offlineDb.emergencyMode };
  if (pathname === "/export" && method === "GET") {
    return {
      exportedAt: offlineNowIso(),
      emergencyMode: offlineDb.emergencyMode,
      dashboard: getOfflineDashboard(),
      tasks: offlineDb.tasks,
      volunteers: offlineDb.volunteers,
      activity: offlineDb.activity
    };
  }

  if (pathname === "/tasks" && method === "POST") {
    const title = String(body.title || "").trim();
    const skill = String(body.skill || "").trim();
    const location = String(body.location || "").trim();
    const priority = String(body.priority || "low").toLowerCase();
    if (!title || !skill || !location || !["low", "medium", "high"].includes(priority)) {
      throw new Error("Valid title, skill, location and priority are required.");
    }

    const task = {
      id: offlineId("task"),
      title,
      skill,
      location,
      priority,
      status: "pending",
      assignedVolunteerId: null,
      createdAt: offlineNowIso(),
      updatedAt: offlineNowIso()
    };
    offlineDb.tasks.unshift(task);
    appendOfflineActivity("TASK_ADDED", `Task \"${task.title}\" created.`, { taskId: task.id });
    persistOfflineDb();
    return task;
  }

  if (pathname === "/volunteers" && method === "POST") {
    const name = String(body.name || "").trim();
    const skills = Array.isArray(body.skills) ? body.skills.map((item) => String(item).trim()).filter(Boolean) : [];
    const location = String(body.location || "").trim();
    const rating = Number(body.rating);

    if (!name || !/^[A-Za-z ]+$/.test(name)) throw new Error("Name must contain alphabets and spaces only.");
    if (skills.length === 0) throw new Error("At least one skill is required.");
    if (!location) throw new Error("Location is required.");
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) throw new Error("Rating must be between 1 and 5.");

    const volunteer = {
      id: offlineId("vol"),
      name,
      skills,
      location,
      status: "available",
      rating,
      activeTaskIds: [],
      createdAt: offlineNowIso(),
      updatedAt: offlineNowIso()
    };
    offlineDb.volunteers.unshift(volunteer);
    appendOfflineActivity("VOLUNTEER_ADDED", `Volunteer ${volunteer.name} added.`, { volunteerId: volunteer.id });
    persistOfflineDb();
    return volunteer;
  }

  if (parts[0] === "volunteers" && parts[1] && method === "PUT") {
    const volunteer = offlineDb.volunteers.find((entry) => entry.id === parts[1]);
    if (!volunteer) throw new Error("Volunteer not found.");

    const name = String(body.name || "").trim();
    const skills = Array.isArray(body.skills) ? body.skills.map((item) => String(item).trim()).filter(Boolean) : [];
    const location = String(body.location || "").trim();
    const rating = Number(body.rating);

    if (!name || !/^[A-Za-z ]+$/.test(name)) throw new Error("Name must contain alphabets and spaces only.");
    if (skills.length === 0) throw new Error("At least one skill is required.");
    if (!location) throw new Error("Location is required.");
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) throw new Error("Rating must be between 1 and 5.");

    volunteer.name = name;
    volunteer.skills = skills;
    volunteer.location = location;
    volunteer.rating = rating;
    volunteer.updatedAt = offlineNowIso();
    persistOfflineDb();
    return volunteer;
  }

  if (parts[0] === "volunteers" && parts[1] && method === "DELETE") {
    const volunteerIndex = offlineDb.volunteers.findIndex((entry) => entry.id === parts[1]);
    if (volunteerIndex < 0) throw new Error("Volunteer not found.");
    const [removedVolunteer] = offlineDb.volunteers.splice(volunteerIndex, 1);

    offlineDb.tasks = offlineDb.tasks.map((task) =>
      task.assignedVolunteerId === removedVolunteer.id
        ? { ...task, assignedVolunteerId: null, status: task.status === "completed" ? "completed" : "pending", updatedAt: offlineNowIso() }
        : task
    );

    appendOfflineActivity("VOLUNTEER_DELETED", `Volunteer ${removedVolunteer.name} deleted.`, {
      volunteerId: removedVolunteer.id
    });
    persistOfflineDb();
    return { message: "Volunteer deleted." };
  }

  if (parts[0] === "tasks" && parts[1] && method === "DELETE") {
    const taskIndex = offlineDb.tasks.findIndex((entry) => entry.id === parts[1]);
    if (taskIndex < 0) throw new Error("Task not found.");
    const [removedTask] = offlineDb.tasks.splice(taskIndex, 1);
    appendOfflineActivity("TASK_DELETED", `Task \"${removedTask.title}\" deleted.`, { taskId: removedTask.id });
    persistOfflineDb();
    return { message: "Task deleted." };
  }

  if (parts[0] === "tasks" && parts[1] && parts[2] === "assign" && method === "POST") {
    const task = offlineDb.tasks.find((entry) => entry.id === parts[1]);
    const volunteer = offlineDb.volunteers.find((entry) => entry.id === body.volunteerId);
    if (!task) throw new Error("Task not found.");
    if (!volunteer) throw new Error("Volunteer not found.");

    task.status = "assigned";
    task.assignedVolunteerId = volunteer.id;
    task.updatedAt = offlineNowIso();
    volunteer.status = "busy";
    volunteer.activeTaskIds = [...new Set([...(volunteer.activeTaskIds || []), task.id])];
    volunteer.updatedAt = offlineNowIso();
    persistOfflineDb();
    return { message: "Task assigned.", task };
  }

  if (parts[0] === "tasks" && parts[1] && parts[2] === "auto-assign" && method === "POST") {
    const task = offlineDb.tasks.find((entry) => entry.id === parts[1]);
    if (!task) throw new Error("Task not found.");
    const { best } = computeOfflineMatches(task);
    if (!best) throw new Error("No volunteers available for matching.");

    task.status = "assigned";
    task.assignedVolunteerId = best.volunteer.id;
    task.updatedAt = offlineNowIso();
    best.volunteer.status = "busy";
    best.volunteer.activeTaskIds = [...new Set([...(best.volunteer.activeTaskIds || []), task.id])];
    best.volunteer.updatedAt = offlineNowIso();
    persistOfflineDb();

    return {
      message: "Task auto-assigned.",
      task,
      assignedVolunteer: best.volunteer,
      aiScore: best.score,
      reasoning: best.reasoning
    };
  }

  if (parts[0] === "tasks" && parts[1] && parts[2] === "complete" && method === "POST") {
    const task = offlineDb.tasks.find((entry) => entry.id === parts[1]);
    if (!task) throw new Error("Task not found.");
    task.status = "completed";
    task.updatedAt = offlineNowIso();
    persistOfflineDb();
    return { message: "Task completed.", task };
  }

  if (pathname === "/tasks/auto-assign-pending" && method === "POST") {
    const pending = offlineDb.tasks.filter((task) => task.status === "pending");
    let assignedCount = 0;
    const results = [];

    pending.forEach((task) => {
      const { best } = computeOfflineMatches(task);
      if (!best) return;
      task.status = "assigned";
      task.assignedVolunteerId = best.volunteer.id;
      task.updatedAt = offlineNowIso();
      best.volunteer.status = "busy";
      best.volunteer.activeTaskIds = [...new Set([...(best.volunteer.activeTaskIds || []), task.id])];
      best.volunteer.updatedAt = offlineNowIso();
      assignedCount += 1;
      results.push({ taskId: task.id, taskTitle: task.title, volunteerId: best.volunteer.id, volunteerName: best.volunteer.name, aiScore: best.score });
    });

    appendOfflineActivity("BULK_AUTO_ASSIGN", `Bulk auto-assigned ${assignedCount} tasks.`, { assignedCount });
    persistOfflineDb();
    return { assignedCount, attempted: pending.length, results };
  }

  if (pathname === "/tasks/completed" && method === "DELETE") {
    const before = offlineDb.tasks.length;
    offlineDb.tasks = offlineDb.tasks.filter((task) => task.status !== "completed");
    const removed = before - offlineDb.tasks.length;
    appendOfflineActivity("CLEAR_COMPLETED", `Cleared ${removed} completed tasks.`, { removed });
    persistOfflineDb();
    return { removed, remaining: offlineDb.tasks.length };
  }

  if (pathname === "/match" && method === "POST") {
    const task = offlineDb.tasks.find((entry) => entry.id === body.taskId);
    if (!task) throw new Error("Task not found.");
    const { best, top3 } = computeOfflineMatches(task);
    if (!best) {
      return {
        task,
        bestVolunteer: null,
        bestScore: 0,
        detailedReasoning: ["No volunteers are currently registered."],
        topMatches: []
      };
    }
    return {
      task,
      bestVolunteer: best.volunteer,
      bestScore: best.score,
      detailedReasoning: best.reasoning,
      topMatches: top3.map((entry) => ({ volunteer: entry.volunteer, score: entry.score, reasoning: entry.reasoning }))
    };
  }

  if (pathname === "/emergency/toggle" && method === "POST") {
    offlineDb.emergencyMode = !offlineDb.emergencyMode;
    persistOfflineDb();
    return { emergencyMode: offlineDb.emergencyMode };
  }

  throw new Error(`Offline route not implemented: ${method} ${pathname}`);
}

function showToast(message, tone = "info") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.style.display = "block";
  toast.style.borderColor = tone === "error" ? "rgba(255, 100, 120, 0.8)" : "rgba(109, 229, 255, 0.7)";
  toast.style.boxShadow = tone === "error" ? "0 0 20px rgba(255, 100, 120, 0.5)" : "0 0 20px rgba(109, 229, 255, 0.4)";

  setTimeout(() => {
    toast.style.display = "none";
  }, 3200);
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  let payload = {};
  if (rawText) {
    if (contentType.includes("application/json")) {
      payload = JSON.parse(rawText);
    } else {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { message: rawText.slice(0, 200) };
      }
    }
  }

  return { payload, contentType, rawText };
}

function looksLikeWrongApiTarget(response, contentType, rawText) {
  if (contentType.includes("text/html")) {
    return true;
  }

  const normalized = rawText.toLowerCase();
  if (normalized.includes("<!doctype html") || normalized.includes("<html")) {
    return true;
  }

  if ([404, 405, 501].includes(response.status)) {
    return normalized.includes("cannot") || normalized.includes("not found") || normalized.includes("method not allowed");
  }

  return false;
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const candidates = [state.apiBase, ...API_CANDIDATES.filter((entry) => entry !== state.apiBase)];
  let lastError = null;

  for (const base of candidates) {
    try {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers
      });

      const { payload, contentType, rawText } = await parseResponse(response);

      if (!response.ok) {
        if (looksLikeWrongApiTarget(response, contentType, rawText)) {
          continue;
        }
        throw new Error(payload.message || `Request failed (${response.status})`);
      }

      state.apiBase = base;
  state.offlineMode = false;
      return payload;
    } catch (error) {
      lastError = error;
      if (error instanceof TypeError) {
        continue;
      }
      if (!String(error.message).includes("Request failed (404)")) {
        throw error;
      }
    }
  }

  state.offlineMode = true;
  return localApiRequest(path, options);
}

async function discoverApi() {
  for (const base of API_CANDIDATES) {
    try {
      const response = await fetch(`${base}/health`);
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload.ok) {
        state.apiBase = base;
        state.offlineMode = false;
        return;
      }
    } catch {
      // keep checking next candidate
    }
  }

  state.offlineMode = true;
}

function switchSection(sectionId) {
  document.querySelectorAll(".section-panel").forEach((panel) => panel.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.remove("active"));

  byId(sectionId).classList.add("active");
  const navButton = document.querySelector(`[data-target="${sectionId}"]`);
  if (navButton) navButton.classList.add("active");
}

function applyTheme(themeName) {
  state.ui.theme = themeName;
  document.body.setAttribute("data-theme", themeName);
  localStorage.setItem("sevs_theme", themeName);
}

function openIntro() {
  const intro = byId("introScreen");
  intro.classList.add("show");

  const seenBefore = localStorage.getItem("sevs_intro_seen") === "true";
  const autoHideDelay = seenBefore ? 1200 : 2600;

  setTimeout(() => {
    intro.classList.remove("show");
  }, autoHideDelay);

  localStorage.setItem("sevs_intro_seen", "true");
}

function initCharacterLayer() {
  const layer = byId("characterLayer");
  const icons = ["🧑‍🚒", "👩‍⚕️", "🚑", "🛰️", "🤖", "🛡️", "📡", "🧯", "👨‍🚒", "🚒"];

  layer.innerHTML = "";
  for (let i = 0; i < 12; i += 1) {
    const item = document.createElement("span");
    item.className = "responder-character";
    item.textContent = icons[i % icons.length];
    item.style.left = `${Math.random() * 92}%`;
    item.style.animationDelay = `${Math.random() * 7}s`;
    item.style.animationDuration = `${8 + Math.random() * 7}s`;
    item.style.fontSize = `${1.2 + Math.random() * 1.6}rem`;
    layer.appendChild(item);
  }
}

function computeLocalSuggestions(task) {
  const taskSkill = String(safe(task.skill)).toLowerCase();
  return state.volunteers
    .map((volunteer) => {
      let score = 0;
      const reasons = [];
      const skills = Array.isArray(volunteer.skills) ? volunteer.skills : [];

      if (skills.map((s) => String(s).toLowerCase()).includes(taskSkill)) {
        score += 50;
        reasons.push("Skill +50");
      }
      if (volunteer.location === task.location) {
        score += 20;
        reasons.push("Location +20");
      }
      if (volunteer.status === "available") {
        score += 20;
        reasons.push("Availability +20");
      }
      score += Number(volunteer.rating || 0);
      reasons.push(`Rating +${Number(volunteer.rating || 0)}`);

      if (state.emergencyMode && task.priority === "high") {
        score += 30;
        reasons.push("Emergency +30");
      }

      return { volunteer, score, reasons };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function getFilteredTasks() {
  const search = state.ui.taskSearch.toLowerCase();
  const priority = state.ui.taskFilterPriority;
  const status = state.ui.taskFilterStatus;

  return state.tasks
    .filter((task) => {
      const matchesSearch =
        !search || [task.title, task.skill, task.location].some((field) => String(field || "").toLowerCase().includes(search));
      const matchesPriority = priority === "all" || task.priority === priority;
      const matchesStatus = status === "all" || task.status === status;

      return matchesSearch && matchesPriority && matchesStatus;
    })
    .sort((a, b) => {
      const priorityDiff = (byPriority[b.priority] || 0) - (byPriority[a.priority] || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
}

function renderDashboard() {
  animateMetric("metricTotalTasks", metricCache.totalTasks, safe(state.dashboard.totalTasks, 0));
  animateMetric("metricCompleted", metricCache.completedTasks, safe(state.dashboard.completedTasks, 0));
  animateMetric("metricVolunteers", metricCache.volunteersCount, safe(state.dashboard.volunteersCount, 0));
  animateMetric("metricEfficiency", metricCache.efficiency, safe(state.dashboard.efficiency, 0), "%");
  animateMetric("metricHighPriority", metricCache.highPriorityCount, safe(state.dashboard.highPriorityCount, 0));

  metricCache.totalTasks = safe(state.dashboard.totalTasks, 0);
  metricCache.completedTasks = safe(state.dashboard.completedTasks, 0);
  metricCache.volunteersCount = safe(state.dashboard.volunteersCount, 0);
  metricCache.efficiency = safe(state.dashboard.efficiency, 0);
  metricCache.highPriorityCount = safe(state.dashboard.highPriorityCount, 0);
}

function animateMetric(elementId, fromValue, toValue, suffix = "") {
  const element = byId(elementId);
  if (!element) return;

  const start = Number(fromValue) || 0;
  const end = Number(toValue) || 0;
  if (start === end) {
    element.textContent = `${end}${suffix}`;
    return;
  }

  const durationMs = 450;
  const startedAt = performance.now();

  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    const current = Math.round(start + (end - start) * progress);
    element.textContent = `${current}${suffix}`;
    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
}

function renderTaskSelect() {
  const select = byId("aiTaskSelect");
  const selected = state.aiSelectionTaskId;

  select.innerHTML = "";
  const assignable = state.tasks.filter((task) => task.status !== "completed");

  assignable.forEach((task) => {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${safe(task.title, "Untitled Task")} (${safe(task.priority, "low")})`;
    if (selected === task.id) option.selected = true;
    select.appendChild(option);
  });

  if (!state.aiSelectionTaskId && assignable[0]) {
    state.aiSelectionTaskId = assignable[0].id;
  }
}

function renderVolunteers() {
  const container = byId("volunteerList");
  container.innerHTML = "";

  if (state.volunteers.length === 0) {
    container.innerHTML = `<div class="glass-card vol-card">No volunteers yet. Add your first responder.</div>`;
    return;
  }

  state.volunteers.forEach((volunteer, index) => {
    const card = document.createElement("div");
    card.className = "glass-card vol-card";

    if (state.ui.highlightedVolunteerId && state.ui.highlightedVolunteerId === volunteer.id) {
      card.classList.add("vol-card-updated");
    }

    const skills = Array.isArray(volunteer.skills) ? volunteer.skills.join(", ") : "N/A";

    card.innerHTML = `
      <h3>${safe(volunteer.name, "Unknown")}</h3>
      <div><strong>Skills:</strong> ${safe(skills, "N/A")}</div>
      <div><strong>Location:</strong> ${safe(volunteer.location, "N/A")}</div>
      <div><strong>Status:</strong> ${safe(volunteer.status, "available")}</div>
      <div><strong>Rating:</strong> ${safe(volunteer.rating, 1)} / 5</div>
<div class="row">
  <button class="action-btn-edit" onclick="editVolunteer(${index})">Edit</button>
  <button class="action-btn-delete" onclick="deleteVolunteer(${index})">Delete</button> <!-- 🔥 ADDED -->
</div>
    `;

    container.appendChild(card);
  });

  if (state.ui.highlightedVolunteerId) {
    setTimeout(() => {
      state.ui.highlightedVolunteerId = null;
      renderVolunteers();
    }, 1700);
  }
}

function renderTasks() {
  const container = byId("taskList");
  container.innerHTML = "";

  const filteredTasks = getFilteredTasks();
  if (filteredTasks.length === 0) {
    container.innerHTML = `<div class="glass-card task-card">No tasks match your current filters.</div>`;
    return;
  }

  filteredTasks.forEach((task) => {
    const card = document.createElement("div");
    card.className = "glass-card task-card";

    if (state.ui.highlightedTaskId && state.ui.highlightedTaskId === task.id) {
      card.classList.add("task-card-added");
    }

    const priority = String(safe(task.priority, "low")).toLowerCase();
    const status = String(safe(task.status, "pending")).toLowerCase();
  const taskIndex = state.tasks.findIndex((entry) => entry.id === task.id);
    const assignedVolunteer = state.volunteers.find((vol) => vol.id === task.assignedVolunteerId);

    const assignOptions = state.volunteers.map((vol) => `<option value="${vol.id}">${vol.name} (${vol.status})</option>`).join("");

    const suggestions = computeLocalSuggestions(task)
      .map(
        (entry, index) =>
          `<div class="suggestion-item">${index + 1}. ${safe(entry.volunteer.name, "Unknown")} — <strong>${entry.score}</strong> (${entry.reasons.join(", ")})</div>`
      )
      .join("");

    card.innerHTML = `
      <h3>${safe(task.title, "Untitled Task")}</h3>
      <div>
        <span class="badge status-${status}">${toTitleCase(status)}</span>
        <span class="priority-dot priority-${priority}"></span>${toTitleCase(priority)} priority
      </div>
      <div><strong>Skill:</strong> ${safe(task.skill, "N/A")}</div>
      <div><strong>Location:</strong> ${safe(task.location, "N/A")}</div>
      <div><strong>Assigned:</strong> ${assignedVolunteer ? assignedVolunteer.name : "Not assigned"}</div>
      <div class="row">
        <select id="assign_${task.id}">
          <option value="">Select volunteer</option>
          ${assignOptions}
        </select>
        <button data-action="assign" data-task-id="${task.id}">Assign</button>
        <button data-action="auto-assign" data-task-id="${task.id}">Auto-Assign</button>
        <button data-action="complete" data-task-id="${task.id}">Complete</button>
        <button class="action-btn-delete" onclick="deleteTask(${taskIndex})">Delete</button>
      </div>
      <div class="suggestions">
        <strong>Smart Suggestions (Top 3)</strong>
        ${suggestions || '<div class="suggestion-item">No volunteers available.</div>'}
      </div>
    `;

    container.appendChild(card);
  });

  if (state.ui.highlightedTaskId) {
    setTimeout(() => {
      state.ui.highlightedTaskId = null;
      renderTasks();
    }, 1300);
  }
}

async function deleteTask(index) {
  const task = state.tasks[index];
  if (!task) {
    return;
  }

  const confirmed = window.confirm(`Delete task \"${task.title}\"?`);
  if (!confirmed) {
    return;
  }

  const [removed] = state.tasks.splice(index, 1);
  renderTasks();

  try {
    await request(`/tasks/${removed.id}`, { method: "DELETE" });
    showToast("Task deleted.");
    await refreshAll();
  } catch (error) {
    state.tasks.splice(index, 0, removed);
    renderTasks();
    showToast(error.message, "error");
  }
}

async function deleteVolunteer(index) {
  const volunteer = state.volunteers[index];
  if (!volunteer) return;

  const confirmed = window.confirm(`Delete volunteer "${volunteer.name}"?`);
  if (!confirmed) return;

  const [removed] = state.volunteers.splice(index, 1);
  renderVolunteers();
  renderTasks();

  try {
    await request(`/volunteers/${removed.id}`, { method: "DELETE" });
    if (state.ui.editingVolunteerId === removed.id) {
      byId("volunteerForm").reset();
      resetVolunteerFormMode();
    }
    showToast("Volunteer deleted.");
    await refreshAll();
  } catch (error) {
    state.volunteers.splice(index, 0, removed);
    renderVolunteers();
    renderTasks();
    showToast(error.message, "error");
  }
}

function editVolunteer(index) {
  const volunteer = state.volunteers[index];
  if (!volunteer) {
    return;
  }

  state.ui.editingVolunteerIndex = index;
  state.ui.editingVolunteerId = volunteer.id;

  byId("volName").value = safe(volunteer.name, "");
  byId("volSkills").value = Array.isArray(volunteer.skills) ? volunteer.skills.join(", ") : "";
  byId("volLocation").value = safe(volunteer.location, "");
  byId("volRating").value = safe(volunteer.rating, "");

  const submitButton = byId("volunteerForm").querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.textContent = "Update Volunteer";
  }
}

function resetVolunteerFormMode() {
  state.ui.editingVolunteerIndex = null;
  state.ui.editingVolunteerId = null;

  const form = byId("volunteerForm");
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.textContent = "Add Volunteer";
  }
}

function renderActivity() {
  const panel = byId("activityList");
  panel.innerHTML = "";

  if (!state.activity.length) {
    panel.innerHTML = `<div class="glass-card log-card">No activity yet.</div>`;
    return;
  }

  state.activity.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "glass-card log-card";
    card.innerHTML = `
      <div><strong>${safe(entry.type, "EVENT")}</strong> • ${new Date(entry.timestamp).toLocaleTimeString()}</div>
      <div>${safe(entry.message, "")}</div>
    `;
    panel.appendChild(card);
  });
}

function renderEmergency() {
  const emergencyStateText = state.emergencyMode ? "ON" : "OFF";

  byId("emergencyStatus").textContent = emergencyStateText;
  const btn = byId("toggleEmergencyBtn");
  btn.classList.toggle("on", state.emergencyMode);
  btn.textContent = state.emergencyMode ? "🚨 Emergency ON" : "Activate Emergency Mode";

  byId("emergencyBanner").classList.toggle("show", state.emergencyMode);
  byId("topBanner").classList.toggle("show", state.emergencyMode);

  if (!state.emergencyMode) {
    clearEmergencyPulse();
  }
}

function triggerEmergencyPulse() {
  const overlay = byId("emergencyOverlay");
  overlay.classList.add("on");
  document.body.classList.add("emergency-pulse");

  if (emergencyPulseTimeout) {
    clearTimeout(emergencyPulseTimeout);
  }

  startSiren(EMERGENCY_PULSE_MS);
  emergencyPulseTimeout = setTimeout(() => {
    overlay.classList.remove("on");
    document.body.classList.remove("emergency-pulse");
    emergencyPulseTimeout = null;
  }, EMERGENCY_PULSE_MS);
}

function clearEmergencyPulse() {
  if (emergencyPulseTimeout) {
    clearTimeout(emergencyPulseTimeout);
    emergencyPulseTimeout = null;
  }
  byId("emergencyOverlay").classList.remove("on");
  document.body.classList.remove("emergency-pulse");
  stopSiren();
}

function renderAll() {
  renderDashboard();
  renderTaskSelect();
  renderVolunteers();
  renderTasks();
  renderActivity();
  renderEmergency();
}

async function refreshAll() {
  const [tasks, volunteers, dashboard, activity, emergency] = await Promise.all([
    request("/tasks"),
    request("/volunteers"),
    request("/dashboard"),
    request("/activity?limit=24"),
    request("/emergency")
  ]);

  state.tasks = dedupeById(tasks);
  state.volunteers = dedupeById(volunteers);
  state.dashboard = dashboard || state.dashboard;
  state.activity = Array.isArray(activity) ? activity : [];
  state.emergencyMode = Boolean(emergency.emergencyMode);
  renderAll();
}

async function addTask(event) {
  event.preventDefault();

  if (state.ui.isSavingTask) {
    return;
  }

  state.ui.isSavingTask = true;
  const submitBtn = byId("taskForm")?.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
  }

  const payload = {
    title: byId("taskTitle").value.trim(),
    skill: byId("taskSkill").value.trim(),
    location: byId("taskLocation").value.trim(),
    priority: byId("taskPriority").value
  };

  try {
    const task = await request("/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state.ui.highlightedTaskId = task.id;
    byId("taskForm").reset();
    showToast("Task created successfully.");
    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.ui.isSavingTask = false;
    if (submitBtn) {
      submitBtn.disabled = false;
    }
  }
}

async function addVolunteer(event) {
  event.preventDefault();

  if (state.ui.isSavingVolunteer) {
    return;
  }

  state.ui.isSavingVolunteer = true;
  const submitBtn = byId("volunteerForm")?.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
  }

  const rawSkills = byId("volSkills").value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const payload = {
    name: byId("volName").value.trim(),
    skills: rawSkills,
    location: byId("volLocation").value.trim(),
    rating: Number(byId("volRating").value)
  };

  const editingIndex = state.ui.editingVolunteerIndex;

  try {
    if (editingIndex !== null && editingIndex >= 0 && editingIndex < state.volunteers.length) {
      const original = state.volunteers[editingIndex];
      const updatedLocal = {
        ...original,
        ...payload,
        id: state.ui.editingVolunteerId || original.id
      };

      state.volunteers.splice(editingIndex, 1, updatedLocal);
      state.ui.highlightedVolunteerId = updatedLocal.id;
      renderVolunteers();

      const updatedVolunteer = await request(`/volunteers/${updatedLocal.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      state.volunteers.splice(editingIndex, 1, updatedVolunteer);
      state.ui.highlightedVolunteerId = updatedVolunteer.id;
      showToast("Volunteer updated successfully.");
    } else {
      const volunteer = await request("/volunteers", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      state.volunteers.unshift(volunteer);
      showToast("Volunteer onboarded successfully.");
    }

    byId("volunteerForm").reset();
    resetVolunteerFormMode();
    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.ui.isSavingVolunteer = false;
    if (submitBtn) {
      submitBtn.disabled = false;
    }
  }
}

async function runAiMatching() {
  const taskId = byId("aiTaskSelect").value;
  if (!taskId) {
    showToast("Please select a task.", "error");
    return;
  }

  state.aiSelectionTaskId = taskId;
  const runButton = byId("runAiBtn");
  runButton.classList.add("ai-running");
  runButton.disabled = true;
  byId("aiResult").innerHTML = `
    <div class="glass-card ai-result ai-loading">
      <div class="spinner"></div>
      <div>AI engine analyzing candidates...</div>
    </div>
  `;

  try {
    const response = await request("/match", {
      method: "POST",
      body: JSON.stringify({ taskId })
    });

    renderAiResult(response);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    runButton.classList.remove("ai-running");
    runButton.disabled = false;
  }
}

function renderAiResult(response) {
  const target = byId("aiResult");
  if (!response.bestVolunteer) {
    target.innerHTML = `<div class="glass-card ai-result">No volunteer match found.</div>`;
    return;
  }

  const topMatches = Array.isArray(response.topMatches) ? response.topMatches : [];
  const normalizedScore = Math.max(0, Math.min(100, Math.round((Number(response.bestScore || 0) / 125) * 100)));
  const hasNearDistance = (response.detailedReasoning || []).some((entry) =>
    String(entry).toLowerCase().includes("same location")
  );
  const distanceExplanation = hasNearDistance ? "Near distance (same location)" : "Farther distance (different location)";

  target.innerHTML = `
    <div class="glass-card ai-result">
      <h3>Best Volunteer: ${safe(response.bestVolunteer.name, "Unknown")}</h3>
      <div><strong>Score:</strong> ${safe(response.bestScore, 0)} <span class="score-pill">${normalizedScore}/100</span></div>
      <div><strong>Detailed Reasoning:</strong> ${(response.detailedReasoning || []).join(" • ")}</div>
      <div><strong>Distance:</strong> ${distanceExplanation}</div>
      <div class="suggestions">
        <strong>Top 3 Matches</strong>
        ${topMatches
          .map(
            (match, idx) =>
              `<div class="suggestion-item">${idx + 1}. ${safe(match.volunteer?.name, "Unknown")} — <strong>${safe(match.score, 0)}</strong><br>${(match.reasoning || []).join(", ")}</div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

async function handleTaskAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const taskId = button.dataset.taskId;
  const action = button.dataset.action;
  if (!taskId || !action) return;

  try {
    if (action === "assign") {
      const volunteerId = byId(`assign_${taskId}`).value;
      if (!volunteerId) {
        showToast("Select a volunteer before assigning.", "error");
        return;
      }

      await request(`/tasks/${taskId}/assign`, {
        method: "POST",
        body: JSON.stringify({ volunteerId })
      });
      showToast("Task assigned.");
    }

    if (action === "auto-assign") {
      const response = await request(`/tasks/${taskId}/auto-assign`, {
        method: "POST"
      });
      showToast(`Auto-assigned to ${response.assignedVolunteer.name} (Score ${response.aiScore})`);
    }

    if (action === "complete") {
      await request(`/tasks/${taskId}/complete`, { method: "POST" });
      showToast("Task completed.");
    }

    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function toggleEmergencyMode() {
  try {
    const response = await request("/emergency/toggle", { method: "POST" });
    state.emergencyMode = Boolean(response.emergencyMode);
    if (state.emergencyMode) {
      triggerEmergencyPulse();
    } else {
      clearEmergencyPulse();
    }
    renderEmergency();
    showToast(state.emergencyMode ? "Emergency mode activated." : "Emergency mode deactivated.");
    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function bulkAutoAssignPending() {
  try {
    const response = await request("/tasks/auto-assign-pending", { method: "POST" });
    showToast(`Bulk auto-assign completed: ${response.assignedCount}/${response.attempted} tasks assigned.`);
    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function clearCompletedTasks() {
  try {
    const response = await request("/tasks/completed", { method: "DELETE" });
    showToast(`Removed ${response.removed} completed tasks.`);
    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function exportSnapshot() {
  try {
    const snapshot = await request("/export");
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smart-emergency-snapshot-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("System snapshot exported.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function startSiren(durationMs = EMERGENCY_PULSE_MS) {
  if (sirenTimer) return;

  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    let high = true;
    sirenTimer = setInterval(() => {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.type = "sawtooth";
      oscillator.frequency.value = high ? 860 : 620;
      gainNode.gain.value = 0.016;

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.18);
      high = !high;
    }, 180);

    if (sirenStopTimeout) {
      clearTimeout(sirenStopTimeout);
    }
    sirenStopTimeout = setTimeout(() => {
      stopSiren();
    }, durationMs);
  } catch {
    // non-blocking for browsers that disallow autoplay audio
  }
}

function stopSiren() {
  if (sirenStopTimeout) {
    clearTimeout(sirenStopTimeout);
    sirenStopTimeout = null;
  }

  if (sirenTimer) {
    clearInterval(sirenTimer);
    sirenTimer = null;
  }
}

function initParticles() {
  const canvas = byId("particles");
  const ctx = canvas.getContext("2d");

  const particles = [];
  const maxParticles = 95;

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };

  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < maxParticles; i += 1) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 2 + 0.5,
      dx: (Math.random() - 0.5) * 0.5,
      dy: (Math.random() - 0.5) * 0.5
    });
  }

  const animate = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach((p) => {
      p.x += p.dx;
      p.y += p.dy;

      if (p.x <= 0 || p.x >= canvas.width) p.dx *= -1;
      if (p.y <= 0 || p.y >= canvas.height) p.dy *= -1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(109, 229, 255, 0.55)";
      ctx.fill();
    });

    requestAnimationFrame(animate);
  };

  animate();
}

function bindEvents() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchSection(btn.dataset.target);
    });
  });

  byId("taskForm").addEventListener("submit", addTask);
  byId("volunteerForm").addEventListener("submit", addVolunteer);
  byId("runAiBtn").addEventListener("click", runAiMatching);
  byId("taskList").addEventListener("click", handleTaskAction);
  byId("toggleEmergencyBtn").addEventListener("click", toggleEmergencyMode);

  byId("taskSearch").addEventListener("input", (event) => {
    state.ui.taskSearch = event.target.value.trim();
    renderTasks();
  });

  byId("taskFilterPriority").addEventListener("change", (event) => {
    state.ui.taskFilterPriority = event.target.value;
    renderTasks();
  });

  byId("taskFilterStatus").addEventListener("change", (event) => {
    state.ui.taskFilterStatus = event.target.value;
    renderTasks();
  });

  byId("themeSelect").addEventListener("change", (event) => {
    applyTheme(event.target.value);
  });

  byId("aiTaskSelect").addEventListener("change", (event) => {
    state.aiSelectionTaskId = event.target.value;
  });

  byId("bulkAutoAssignBtn").addEventListener("click", bulkAutoAssignPending);
  byId("clearCompletedBtn").addEventListener("click", clearCompletedTasks);
  byId("exportSnapshotBtn").addEventListener("click", exportSnapshot);

  byId("enterAppBtn").addEventListener("click", () => {
    byId("introScreen").classList.remove("show");
  });
}

async function bootstrap() {
  bindEvents();
  initParticles();
  initCharacterLayer();
  applyTheme(state.ui.theme);
  byId("themeSelect").value = state.ui.theme;
  openIntro();

  await discoverApi();

  try {
    await refreshAll();
    if (state.offlineMode) {
      showToast("Backend unreachable. Running in offline mode with local storage.", "error");
    } else {
      showToast(`Connected to API: ${state.apiBase.replace("/api", "")}`);
    }
  } catch (error) {
    showToast(`Startup error: ${error.message}`, "error");
  }

  setInterval(async () => {
    try {
      await refreshAll();
    } catch (error) {
      console.error("Auto refresh failed", error);
    }
  }, 2500);
}

bootstrap();
