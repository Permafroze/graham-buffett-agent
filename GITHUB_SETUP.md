# GitHub Setup Guide

Follow these steps once to connect the app to GitHub.
After that, updates are one click inside the app.

---

## Step 1 — Install Git

Download from https://git-scm.com/download/win and install with all defaults.

Verify it worked — open Command Prompt and run:
```
git --version
```

---

## Step 2 — Create a GitHub account

Go to https://github.com and sign up (free).

---

## Step 3 — Create a new repository on GitHub

1. Click the **+** button in the top-right → **New repository**
2. Name it: `graham-buffett-agent`
3. Set it to **Private** (your API key is NOT stored here, but good practice)
4. Do NOT check "Add a README" — leave it empty
5. Click **Create repository**
6. Copy the repository URL shown on the next page — it looks like:
   `https://github.com/YOUR_USERNAME/graham-buffett-agent.git`

---

## Step 4 — Edit package.json

Open `package.json` in Notepad and replace `YOUR_USERNAME` with your actual GitHub username:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/YOUR_USERNAME/graham-buffett-agent"
}
```

---

## Step 5 — Push the app to GitHub

Open Command Prompt in the app folder and run these commands one at a time:

```
git init
git add .
git commit -m "Initial release v2.1.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/graham-buffett-agent.git
git push -u origin main
```

GitHub will ask you to log in — use your GitHub username and password.

---

## Step 6 — Done!

The app is now on GitHub. The auto-update system works like this:

- Every time you open the app, it silently checks GitHub for a newer version
- If one exists, a pulsing **"⬆ Update available"** badge appears in the sidebar
- Click **"Install Update & Restart"** — it runs `git pull` + `npm install` and restarts automatically
- No manual file downloads ever again

---

## How to publish an update (when you make changes)

After editing any files, run:
```
git add .
git commit -m "Description of what changed"
git tag v2.2.0
git push && git push --tags
```

The version tag (`v2.2.0`) is what the app checks — bump it to trigger the update notification for anyone running the old version.
