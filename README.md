# Smart Emergency Volunteer Coordination System

A production-ready hackathon-grade web app for coordinating emergency response volunteers in real time.

## Stack

- Frontend: HTML, CSS, JavaScript (vanilla)
- Backend: Node.js + Express
- Data: In-memory arrays

## Features

- Task management: add, assign, auto-assign, complete
- Volunteer management with strict validation
- AI matching engine with weighted scoring and full reasoning
- Emergency mode with red flashing overlay + siren + banner
- Real-time dashboard metrics and activity logs
- Auto-refresh every 2.5 seconds
- Cinematic, responsive glassmorphism UI with particles and neon cards
- Startup cinematic intro experience
- Animated responder characters in the background
- Theme switcher with 3 visual styles
- Task search and priority/status filters
- Bulk auto-assign pending tasks
- Export full system snapshot JSON
- Clear completed tasks from command panel

## Run

From `backend/`:

```bash
npm install
npm start
```

Open `http://localhost:5001`.

## Optional verification

Run smoke tests while server is running:

```bash
npm run test:smoke
```

## Validation Rules

- Volunteer name: alphabets and spaces only
- Skills: non-empty array
- Location: must be in curated real-city list
- Rating: 1 to 5

## Notes

- This project intentionally uses in-memory storage for hackathon speed.
- Restarting the server resets all data.

## Troubleshooting

- If "Request failed" appears in a browser opened on `127.0.0.1`, the frontend now auto-discovers `localhost:5001` API.
- Task/volunteer location must be a real city in the backend city list (e.g., `New York`, `Tokyo`, `London`).
