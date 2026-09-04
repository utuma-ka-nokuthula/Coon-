# Coon — GitHub + Render + Supabase

Coon is an Instagram-style camera/social MVP with live camera filters, posts, likes, comments, follows, notifications, DMs and a local AI suggestion endpoint.

## Current architecture

- **GitHub** — source code
- **GitHub Pages** — static frontend (or another static host)
- **Render** — Node/Express API
- **Supabase** — PostgreSQL database + Storage (`media` bucket)

## Supabase setup

1. Create a Supabase project.
2. Create the `media` Storage bucket. For this MVP, a public bucket is expected so feed media can render directly.
3. Run the Coon SQL schema supplied with this project.
4. On Render, add these environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (**server only; never commit this**)
   - `SUPABASE_STORAGE_BUCKET=media`
   - `JWT_SECRET`
   - `CORS_ORIGIN` = your frontend URL

The backend uploads media automatically when someone creates a post; users do not need to upload files manually into Supabase.

## Important

The backend uses the Supabase service-role key, so keep it only in Render/server environment variables. Never put it in `frontend/index.html`, GitHub, or a browser-exposed variable.

The MVP uses the existing custom JWT auth and bcrypt password hashing. Supabase Auth can be adopted later if desired.

## Free-tier note

Free hosting can sleep or have resource/storage limits. Supabase Storage is persistent, while Render's local filesystem is not used for user media in this version.
