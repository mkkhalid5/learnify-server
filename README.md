# Learnify — Server (Backend API)

## Project Description

This is the **backend API** for Learnify, an online learning marketplace. It is a single Express + TypeScript service backed by MongoDB, responsible for all data that isn't handled by the frontend's auth layer: categories, courses, users listing, contact messages, image uploads, and dashboard statistics.

### What it does
- Stores and serves course **categories** and **courses** (full CRUD, with search/pagination/filtering) so the frontend catalog and admin dashboard have real data to work with.
- Handles image uploads (category/course thumbnails) by streaming them to **Cloudinary**.
- Accepts public **contact form** submissions and exposes them to the admin dashboard for triage (read/unread status, delete).
- Exposes a lightweight **users** list (read from the `user` collection managed by the frontend's Better Auth setup).
- Provides a **dashboard summary** endpoint with aggregated counts (categories, courses, students, revenue) for the admin overview page.

## Tech Stack

| Category | Technology |
|---|---|
| Runtime | Node.js + TypeScript (`ts-node-dev` for local dev, `--transpile-only`) |
| Framework | Express 5 |
| Database | MongoDB (native driver, no ORM) |
| File uploads | Multer (memory storage) → Cloudinary |
| Cross-origin | `cors` (configurable allowed origin) |
| Config | `dotenv` |

## Response Format

Every endpoint returns a consistent JSON envelope:

```json
// success
{ "success": true, "message": "...", "data": { ... } }

// error
{ "success": false, "message": "...", "error": { ... } }
```

List endpoints return paginated data as:

```json
{ "data": [ ... ], "total": 42, "page": 1, "limit": 10, "totalPages": 5 }
```

## Routes and What They Do

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Basic health/uptime check |
| `GET` | `/health` | Health status endpoint |
| `GET` | `/dashboard/summary` | Aggregated stats for the admin overview: total categories, courses, students, revenue |
| `POST` | `/upload` | Uploads a single image (multipart form, "image" field, 5MB max, image mimetypes only) to Cloudinary and returns the hosted URL |
| `GET` | `/categories` | Paginated, searchable list of categories (`search`, `page`, `limit`) |
| `POST` | `/categories` | Create a category (`name`, `image`, `description`); slug is auto-generated and kept unique |
| `PATCH` | `/categories/:id` | Update a category |
| `DELETE` | `/categories/:id` | Delete a category |
| `GET` | `/courses` | Paginated, searchable, filterable list of courses (search, category, level, status, sort) |
| `POST` | `/courses` | Create a course (title, thumbnail, description, category, level, language, duration, price, requirements, outcomes, etc.) |
| `PATCH` | `/courses/:id` | Update a course |
| `DELETE` | `/courses/:id` | Delete a course |
| `GET` | `/users` | List users (sourced from the Better Auth `user` collection) |
| `POST` | `/messages` | **Public.** Submit a contact form message (`name`, `email`, `subject?`, `message`); validates required fields and email format, stored with `status: "new"` |
| `GET` | `/messages` | Paginated, searchable list of messages for the admin dashboard, with optional `status` filter (`new`/`read`) |
| `PATCH` | `/messages/:id` | Update a message's status (`new` or `read`) |
| `DELETE` | `/messages/:id` | Delete a message |

Validation errors return `400` with an `issues` array describing each invalid field. Not-found resources return `404`.

## Data Model (MongoDB collections)

- **`categories`** — `name`, `slug` (unique), `image`, `description`, `createdAt`, `updatedAt`
- **`courses`** — `title`, `slug` (unique), `thumbnail`, `shortDescription`, `description`, `category`, `instructorId`, `level`, `language`, `duration`, `price`, `discountPrice`, `requirements[]`, `outcomes[]`, `totalLessons`, `totalStudents`, `status`, timestamps
- **`user`** — managed by the frontend's Better Auth setup; this service only reads it (`name`, `email`, `emailVerified`, `image`, timestamps)
- **`messages`** — `name`, `email`, `subject`, `message`, `status` (`new`/`read`), timestamps

## Prerequisites

- Node.js 20+ and npm
- A MongoDB database (Atlas or self-hosted) — the same one the frontend's auth uses, or a separate one, as long as `MONGODB_URI` points to it
- A Cloudinary account (for image uploads)

## Getting Started (from a fresh GitHub clone)

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd <repo-name>/server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in `server/` with:
   ```env
   PORT=8000
   MONGODB_URI=your_mongodb_connection_string
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   CORS_ORIGIN=http://localhost:3000
   ```
   - `PORT` — port the API listens on (defaults to 8000 if omitted).
   - `MONGODB_URI` — your MongoDB connection string.
   - `CLOUDINARY_*` — credentials from your Cloudinary dashboard, used for image uploads.
   - `CORS_ORIGIN` — the URL of the frontend allowed to call this API (e.g. your Next.js app's URL).

4. **Run in development mode**
   ```bash
   nodemon server.ts or node server.ts
   ```
   The API starts on `http://localhost:8000` (or your configured `PORT`) and auto-restarts on file changes.

5. Point the frontend's `NEXT_PUBLIC_API_URL` (see `client/README.md`) at this server's URL so the two apps can talk to each other.

## Available Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the API with `ts-node-dev` (auto-restart on change) |

## Known Gaps

- No authentication/authorization is currently enforced on any route (including admin-only actions like create/update/delete for categories, courses, and messages). See the root `PROJECT_REQUIREMENTS.md` for recommended follow-up work before production use.
- No rate limiting on the public `POST /messages` endpoint.
