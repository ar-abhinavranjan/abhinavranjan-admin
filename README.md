# AR. Admin — admin.abhinavranjan.qzz.io

Private admin panel for **Messages** and **Booking appointments** submitted through the main site.
Vanilla HTML/CSS/JS, no build step. Data stays in your private `data-netlify` repo.

## How it works

```
visitor -> abhinavranjan.qzz.io -> /api/saveContact -> data-netlify/contact_submissions.json
                                                              |
you -> admin.abhinavranjan.qzz.io -> /api/admin-data (checks signed session cookie on the server)
                                          |-- reads  contact_submissions.json   (read only)
                                          '-- writes admin_state.json           (status, notes, soft-delete)
```

- **Messages** = normal contact form entries. **Appointments** = entries whose text starts with
  `APPOINTMENT REQUEST DETAILS` (what the appointment form sends today). Date, reason, phone and notes
  are parsed out of that text.
- Admin changes go to a separate `admin_state.json`, so they can never collide with new submissions.
- "Delete" is a soft delete (hidden from the panel, Undo offered). The raw submission stays in `data-netlify`.

## Security design

- Password is stored only as a **scrypt hash** in a Netlify env var. Nothing secret is in this repo.
- Login issues an **HMAC-signed session cookie**: `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict`, 8 h expiry.
- **Every data call re-checks the cookie on the server.** Hiding the UI is not the protection.
- Writes also need a custom header and a same-origin `Origin` (CSRF defence).
- Login: generic error, 700 ms delay on failure, lockout after 5 failures per 15 min (best effort, see limits).
- Strict CSP (no inline scripts or styles), `noindex` everywhere, only `/public` is published.
- All visitor text is shown with `textContent`, so hostile HTML in a message stays inert.

## Setup (about 15 minutes)

1. **New private GitHub repo** (e.g. `admin-abhinavranjan`). Unzip, then push the **contents** so that `netlify.toml` and the `public/` folder sit at the repo root (not inside an extra folder). The page Netlify serves is `public/index.html`.
2. **Make your login values** on your own computer (Node 18+):
   ```
   node tools/make-hash.js
   ```
   Type a password of 12+ characters. It prints `ADMIN_PASS_HASH` and `ADMIN_SESSION_SECRET`.
3. **Netlify → Add new site → Import from GitHub** → pick the repo. Build command: none. Publish dir: `public`
   (already set in `netlify.toml`).
4. **Environment variables** (Site configuration → Environment variables; tick "Contains secret values"):

   | Key | Value |
   |---|---|
   | `GITHUB_TOKEN` | fine-grained token, **only** `data-netlify`, Contents: Read and write |
   | `GITHUB_REPO_OWNER` | `ar-abhinavranjan` |
   | `GITHUB_SUBMISSIONS_REPO` | `data-netlify` |
   | `ADMIN_USER` | the username you want |
   | `ADMIN_PASS_HASH` | from step 2 |
   | `ADMIN_SESSION_SECRET` | from step 2 |

   Optional: `SUBMISSIONS_PATH` (default `contact_submissions.json`), `STATE_PATH` (default `admin_state.json`), `GITHUB_BRANCH` (default `main`).
5. **Custom domain:** Netlify → Domain management → Add `admin.abhinavranjan.qzz.io`. Then, where the DNS for
   `abhinavranjan.qzz.io` is managed, add a **CNAME** record: name `admin` → `<your-site>.netlify.app`.
   HTTPS certificate is issued automatically after DNS resolves.
6. **Deploy**, open the site, sign in, and check that your test message from earlier appears.

## Everyday use

- Tabs: **Overview**, **Messages**, **Appointments** (badges show unread counts).
- Per item: Mark new/read/done, Reply by email, WhatsApp, private note, Delete (with Undo).
- Search, status filters, sort (appointments can sort by appointment date).
- Auto-refreshes every 60 s (`public/config.json` → `refreshSeconds`). Branding and timezone are in the same file.

## Maintenance

- **Sign everyone out / revoke sessions:** change `ADMIN_SESSION_SECRET` and redeploy.
- **Change password:** run `make-hash.js` again, update `ADMIN_PASS_HASH`, redeploy.
- **Self-test:** `node tools/selftest.js` (offline, mocks GitHub).

## Known limits (honest list)

- Login lockout counters live in function memory, so they can reset when Netlify restarts an instance.
  The 700 ms delay and scrypt cost still slow guessing. For stronger protection, put the subdomain behind
  Cloudflare Access or an IP allowlist.
- Appointment fields come from the message text format. If you change `buildFullApptText` in the main site,
  update `parseAppointment` in `netlify/functions/_lib.js` to match.
- Visitor text is stored with `< > " '` escaped by the main site; the panel decodes those for display only.
- The main-site form does not send the phone for plain messages, so message phone is often empty.
