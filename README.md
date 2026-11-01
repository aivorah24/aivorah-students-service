# aivorah-students-service

Student roster management: teachers invite/link/remove/promote students and bulk import; parents link/create children, manage their logins and get AI progress reports; student profile, weekly stats and mistake trends.

**Called by:** frontend teacher My Students, parent My Kids / AI Progress Report, student dashboard.

## Endpoints
| Route | What it does |
|---|---|
| `/teacher/:teacherEmail/students/*` | Invite, link existing, link created, remove, promote, bulk import, CSV/XLSX templates |
| `POST /teacher/students/init-auth` | Create the Firebase login for a new student |
| `/parent/:parentEmail/children/*` | List, link, edit, remove children; credentials, resend, reset password; AI report |
| `POST /parent/children/email-otp/send, /verify` | Email OTP when linking a child |
| `GET /student/available-to-link` | Students a teacher/parent may link |
| `GET /student/:id, /:id/weekly, /:id/mistake-trends` | Student profile, weekly stats, mistake trends |
| `GET /health` | Health check |

## Run locally
```bash
npm ci
cp .env.example .env   # fill in values; see table below
npm run dev            # nodemon, port 3017
```

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `3017`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project and service-role key (server-only, never expose) |
| `FIREBASE_SERVICE_ACCOUNT` or `FIREBASE_SERVICE_ACCOUNT_B64` | Firebase Admin credentials (JSON, or base64 of the JSON) |
| `RESEND_API_KEY` / `EMAIL_USER`, `EMAIL_PASS` | Outgoing email: Resend, or Gmail SMTP as fallback |
| `FIREBASE_API_KEY` | Firebase Web API key, used to create student logins |
| `AUTH_SERVICE_URL` | aivorah-auth-service base URL (invites) |
| `APP_URL` | App link in invite emails |
| `LEARNING_PATHS_SERVER_URL`, `LEARNING_PATHS_SERVICE_URL` | aivorah-learning-paths-service base URL. Two names are used by different routes; set both |
| `GROQ_API_KEY` | AI progress report for parents |

## Tests
```bash
npm test
```

## Deploy
- **Render** web service `aivorah-students-service` → https://aivorah-students-service.onrender.com
- Auto-deploys from `main`. Build `npm install`, start `npm start`.
- CI: `.circleci/config.yml` and `.github/workflows/ci.yml` run the tests (GitHub Actions is billing-blocked on the account)
- After a merge, check the live commit on Render matches the branch head.

## Auth
No token check yet: trusts the teacher/parent email in the URL. See the auth audit in `aivorah-handover`.

## Folder layout
| Path | Why it exists |
|---|---|
| `index.js` | Express app: middleware, route mounting, `/health`, listen |
| `routes/` | `teacher.js`, `parent.js`, `student.js` |
| `services/` | Student accounts and invites, grade matching, promotion notifications, OTP store, learning profile, curriculum, mailer, Firebase/Supabase clients |
| `tests/` | Jest tests |
