const API_CANDIDATES = (() => {
  const candidates = [];
  const origin = window.location.origin;

  if (origin && !origin.startsWith("file:")) {
    candidates.push(`${origin}/api`);
  }

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
  ui: {
    taskSearch: "",
    taskFilterPriority: "all",
    taskFilterStatus: "all",
    theme: localStorage.getItem("sevs_theme") || "aurora",
    editingVolunteerIndex: null,
    editingVolunteerId: null,
    highlightedVolunteerId: null
  }
};

let sirenTimer = null;
let audioCtx = null;
let sirenStopTimeout = null;
let emergencyPulseTimeout = null;
const EMERGENCY_PULSE_MS = 2500;

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

  throw lastError || new Error("Unable to connect to backend API. Start server on port 5001.");
}

async function discoverApi() {
  for (const base of API_CANDIDATES) {
    try {
      const response = await fetch(`${base}/health`);
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload.ok) {
        state.apiBase = base;
        return;
      }
    } catch {
      // keep checking next candidate
    }
  }
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
  byId("metricTotalTasks").textContent = safe(state.dashboard.totalTasks, 0);
  byId("metricCompleted").textContent = safe(state.dashboard.completedTasks, 0);
  byId("metricVolunteers").textContent = safe(state.dashboard.volunteersCount, 0);
  byId("metricEfficiency").textContent = `${safe(state.dashboard.efficiency, 0)}%`;
  byId("metricHighPriority").textContent = safe(state.dashboard.highPriorityCount, 0);
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
  if (!volunteer) {
    return;
  }

  const confirmed = window.confirm(`Delete volunteer \"${volunteer.name}\"?`);
  if (!confirmed) {
    return;
  }

  const [removed] = state.volunteers.splice(index, 1);
  renderVolunteers();

  if (state.ui.editingVolunteerId === removed.id) {
    byId("volunteerForm").reset();
    resetVolunteerFormMode();
  }

  try {
    await request(`/volunteers/${removed.id}`, { method: "DELETE" });
    showToast("Volunteer deleted.");
    await refreshAll();
  } catch (error) {
    state.volunteers.splice(index, 0, removed);
    renderVolunteers();
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

  if (emergencyPulseTimeout) {
    clearTimeout(emergencyPulseTimeout);
  }

  startSiren(EMERGENCY_PULSE_MS);
  emergencyPulseTimeout = setTimeout(() => {
    overlay.classList.remove("on");
    emergencyPulseTimeout = null;
  }, EMERGENCY_PULSE_MS);
}

function clearEmergencyPulse() {
  if (emergencyPulseTimeout) {
    clearTimeout(emergencyPulseTimeout);
    emergencyPulseTimeout = null;
  }
  byId("emergencyOverlay").classList.remove("on");
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

  state.tasks = Array.isArray(tasks) ? tasks : [];
  state.volunteers = Array.isArray(volunteers) ? volunteers : [];
  state.dashboard = dashboard || state.dashboard;
  state.activity = Array.isArray(activity) ? activity : [];
  state.emergencyMode = Boolean(emergency.emergencyMode);
  renderAll();
}

async function addTask(event) {
  event.preventDefault();

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

    state.tasks.unshift(task);
    byId("taskForm").reset();
    showToast("Task created successfully.");
    await refreshAll();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function addVolunteer(event) {
  event.preventDefault();

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

  target.innerHTML = `
    <div class="glass-card ai-result">
      <h3>Best Volunteer: ${safe(response.bestVolunteer.name, "Unknown")}</h3>
      <div><strong>Score:</strong> ${safe(response.bestScore, 0)}</div>
      <div><strong>Detailed Reasoning:</strong> ${(response.detailedReasoning || []).join(" • ")}</div>
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
    showToast(`Connected to API: ${state.apiBase.replace("/api", "")}`);
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
