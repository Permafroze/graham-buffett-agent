import express         from 'express';
import { exec }        from 'child_process';
import { execSync }    from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer }  from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const CFG_FILE  = join(ROOT, 'config.json');
const MDL_FILE  = join(ROOT, 'models_cache.json');

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  if (existsSync(CFG_FILE)) {
    try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch {}
  }
  return { provider: 'gemini', model: 'gemini-3-flash-preview', apiKey: '' };
}
function saveConfig(cfg) { writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); }

app.get('/api/config', (_req, res) => res.json(loadConfig()));
app.post('/api/config', (req, res) => { saveConfig(req.body); res.json({ ok: true }); });

// ── Default model lists ───────────────────────────────────────────────────────
const DEFAULT_MODELS = {
  anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
  openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'],
  gemini:    ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};

function loadModelCache() {
  if (existsSync(MDL_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(MDL_FILE, 'utf8'));
      if (Date.now() - (cache.fetchedAt || 0) < 86400000) return cache.models;
    } catch {}
  }
  return null;
}
function saveModelCache(models) {
  writeFileSync(MDL_FILE, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
}

app.get('/api/models/:provider', (req, res) => {
  const list = (loadModelCache() || DEFAULT_MODELS)[req.params.provider] || [];
  res.json(list);
});

// ── Live model fetch ──────────────────────────────────────────────────────────
app.post('/api/update-models', async (req, res) => {
  const { apiKey, provider } = req.body;
  const updated = { ...DEFAULT_MODELS };
  const errors  = {};

  try {
    const key = provider === 'gemini' ? apiKey : '';
    if (key) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`);
      if (r.ok) {
        const data = await r.json();
        const flash = (data.models || [])
          .map(m => m.name.replace('models/', ''))
          .filter(n => n.includes('flash') && !n.includes('embedding') && !n.includes('aqa') && !n.includes('live') && !n.includes('image') && !n.includes('audio'))
          .sort((a, b) => {
            const rank = n => n.startsWith('gemini-3.') ? 0 : n.startsWith('gemini-3-') ? 1 : n.startsWith('gemini-2.5') ? 2 : n.startsWith('gemini-2.0') ? 3 : 4;
            return rank(a) - rank(b);
          });
        if (flash.length > 0) updated.gemini = flash;
      } else { errors.gemini = `HTTP ${r.status}`; }
    }
  } catch (e) { errors.gemini = e.message; }

  try {
    const key = provider === 'anthropic' ? apiKey : '';
    if (key) {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      });
      if (r.ok) {
        const data = await r.json();
        const models = (data.data || []).map(m => m.id).filter(id => !id.includes('instant') && !id.includes('legacy')).sort((a, b) => b.localeCompare(a));
        if (models.length > 0) updated.anthropic = models;
      } else { errors.anthropic = `HTTP ${r.status}`; }
    }
  } catch (e) { errors.anthropic = e.message; }

  try {
    const key = provider === 'openai' ? apiKey : '';
    if (key) {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': `Bearer ${key}` } });
      if (r.ok) {
        const data = await r.json();
        const priority = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-4-turbo'];
        const chat = (data.data || []).map(m => m.id)
          .filter(id => (id.startsWith('gpt-4') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) && !id.includes('instruct') && !id.includes('vision') && !id.includes('0301') && !id.includes('0314') && !id.includes('0613'))
          .sort((a, b) => { const ai = priority.indexOf(a), bi = priority.indexOf(b); return ai !== -1 && bi !== -1 ? ai - bi : ai !== -1 ? -1 : bi !== -1 ? 1 : b.localeCompare(a); });
        if (chat.length > 0) updated.openai = chat;
      } else { errors.openai = `HTTP ${r.status}`; }
    }
  } catch (e) { errors.openai = e.message; }

  saveModelCache(updated);
  res.json({ ok: true, models: updated, errors });
});

// ── Auto-update from GitHub ───────────────────────────────────────────────────

// Read current version from package.json
function getLocalVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

// Read GitHub repo from package.json repository field
function getGithubRepo() {
  try {
    const pkg  = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const repo = pkg.repository?.url || pkg.repository || '';
    // Handle formats: "github:user/repo", "https://github.com/user/repo", "user/repo"
    const match = repo.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    return match ? match[1].replace(/\.git$/, '') : null;
  } catch { return null; }
}

// Check if git is available and repo is set up
function isGitRepo() {
  try { execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'pipe' }); return true; }
  catch { return false; }
}

// Compare semver strings: returns true if remote > local
function isNewer(local, remote) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [lM, lm, lp] = parse(local);
  const [rM, rm, rp] = parse(remote);
  return rM > lM || (rM === lM && rm > lm) || (rM === lM && rm === lm && rp > lp);
}

// GET /api/app-version — returns local version + GitHub latest + whether update available
app.get('/api/app-version', async (_req, res) => {
  const local  = getLocalVersion();
  const repo   = getGithubRepo();
  const gitOk  = isGitRepo();

  if (!repo) {
    return res.json({ local, remote: null, updateAvailable: false, error: 'No GitHub repo configured in package.json' });
  }

  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'graham-buffett-agent' }
    });
    if (!r.ok) {
      // No releases yet — try comparing commits instead
      const commitsR = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
        headers: { 'User-Agent': 'graham-buffett-agent' }
      });
      if (commitsR.ok) {
        const commits = await commitsR.json();
        const remoteHash = commits[0]?.sha?.slice(0, 7) || '';
        let localHash = '';
        try { localHash = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch {}
        const updateAvailable = gitOk && remoteHash && localHash && remoteHash !== localHash;
        return res.json({ local, remote: remoteHash, localHash, updateAvailable, useCommits: true, gitOk });
      }
      return res.json({ local, remote: null, updateAvailable: false, error: `GitHub: HTTP ${r.status}` });
    }
    const release = await r.json();
    const remote  = release.tag_name?.replace(/^v/, '') || '0.0.0';
    res.json({ local, remote, updateAvailable: isNewer(local, remote), releaseUrl: release.html_url, gitOk });
  } catch (e) {
    res.json({ local, remote: null, updateAvailable: false, error: e.message });
  }
});

// POST /api/app-update — pulls latest from GitHub and restarts
app.post('/api/app-update', async (_req, res) => {
  if (!isGitRepo()) {
    return res.status(400).json({ ok: false, error: 'This folder is not a git repository. Run: git init && git remote add origin <your-repo-url>' });
  }

  try {
    // Pull latest code
    const pull = execSync('git pull origin main', { cwd: ROOT, stdio: 'pipe' }).toString();

    // Install any new dependencies
    execSync('npm install --prefer-offline', { cwd: ROOT, stdio: 'pipe' });

    // Send success before restarting
    res.json({ ok: true, output: pull });

    // Restart the server after a short delay so the response can be sent
    setTimeout(() => {
      console.log('\n  Restarting after update...\n');
      exec(`cd "${ROOT}" && node src/server.js`, (err) => {
        if (err) console.error('Restart error:', err);
      });
      process.exit(0);
    }, 800);

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Analysis ──────────────────────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  const { ticker, provider, model, apiKey } = req.body;
  if (!ticker)   return res.status(400).json({ error: 'Ticker is required' });
  if (!apiKey)   return res.status(400).json({ error: 'API key is required' });
  if (!provider) return res.status(400).json({ error: 'Provider is required' });

  try {
    let rawText = '';
    const sys  = `You are a CFA-level fundamental investment analyst with encyclopedic knowledge of all publicly traded equities. You follow the Benjamin Graham and Warren Buffett value investing philosophy.`;
    const user = buildUserPrompt(ticker.toUpperCase().trim());

    if (provider === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const resp = await new Anthropic({ apiKey }).messages.create({
        model: model || 'claude-opus-4-5', max_tokens: 3000,
        system: sys, messages: [{ role: 'user', content: user }],
      });
      rawText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');

    } else if (provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      const resp = await new OpenAI({ apiKey }).chat.completions.create({
        model: model || 'gpt-4o', max_tokens: 3000,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      });
      rawText = resp.choices[0].message.content || '';

    } else if (provider === 'gemini') {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const mdl = new GoogleGenerativeAI(apiKey).getGenerativeModel({
        model: model || 'gemini-3-flash-preview',
        systemInstruction: sys,
        generationConfig: { maxOutputTokens: 3000 },
      });
      rawText = (await mdl.generateContent(user)).response.text();

    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response — try again');
    const data = JSON.parse(match[0]);
    data.ticker = (data.ticker || ticker).toUpperCase();
    res.json({ ok: true, data });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildUserPrompt(t) {
  return `Analyse publicly traded stock: ${t}. Return ONLY raw JSON, no markdown fences.
{"ticker":"${t}","companyName":"","sector":"","currentPrice":0,"marketCap":"","currency":"USD","verdict":"BUY","verdictReason":"",
"metrics":{"peRatio":0,"peStatus":"good","pbRatio":0,"pbStatus":"fair","debtToEquity":0,"debtStatus":"good","roe":0,"roeStatus":"good","dividendYield":0,"currentRatio":0,"currentStatus":"good","grossMargin":0,"marginStatus":"good"},
"intrinsicValue":{"grahamNumber":0,"dcfValue":0,"earningsPowerValue":0,"bookValue":0,"consensusIntrinsic":0,"marginOfSafety":0,"notes":""},
"expectedReturn":{"earningsYield":0,"dividendYield":0,"expectedEpsGrowth":0,"totalExpectedReturn":0,"riskFreeRate":4.3,"excessReturn":0,"timeHorizon":"5-10 years","returnAssessment":"Attractive"},
"moat":{"overallRating":"Moderate","overallScore":60,"sources":[{"name":"","score":0,"description":""},{"name":"","score":0,"description":""},{"name":"","score":0,"description":""},{"name":"","score":0,"description":""}],"durability":"Stable","moatSummary":""},
"revenueForecasts":[{"year":2022,"revenue":0,"type":"actual","growth":null,"justification":"Historical"},{"year":2023,"revenue":0,"type":"actual","growth":0,"justification":"Historical"},{"year":2024,"revenue":0,"type":"actual","growth":0,"justification":"Historical"},{"year":2025,"revenue":0,"type":"projected","growth":0,"justification":""},{"year":2026,"revenue":0,"type":"projected","growth":0,"justification":""},{"year":2027,"revenue":0,"type":"projected","growth":0,"justification":""},{"year":2028,"revenue":0,"type":"projected","growth":0,"justification":""},{"year":2029,"revenue":0,"type":"projected","growth":0,"justification":""}],
"thesis":"","risks":""}
Rules: verdict=BUY|HOLD|AVOID. statuses=good|fair|poor. overallRating=Strong|Moderate|Narrow|None. durability=Durable|Stable|Narrowing|At Risk. returnAssessment=Attractive|Adequate|Unattractive. Revenue billions USD. Percentages as plain numbers. ONLY JSON.`;
}

// ── Launch ────────────────────────────────────────────────────────────────────
const PORT = 3000;
createServer(app).listen(PORT, async () => {
  const ver = getLocalVersion();
  console.log('\n  Graham-Buffett Investment Agent v' + ver);
  console.log('  Open: http://localhost:' + PORT + '\n');
  exec('start http://localhost:' + PORT);

  // Auto-refresh model lists on startup using saved API key (silent — errors ignored)
  try {
    const cfg = loadConfig();
    if (cfg.apiKey && cfg.provider) {
      console.log('  Refreshing model list from ' + cfg.provider + '...');
      const cached = loadModelCache();
      // Only fetch if cache is older than 6 hours
      if (!cached) {
        const baseUrl = 'http://localhost:' + PORT;
        fetch(baseUrl + '/api/update-models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: cfg.apiKey, provider: cfg.provider }),
        }).then(r => r.json()).then(j => {
          if (j.ok) console.log('  Models updated successfully.\n');
        }).catch(() => {});
      } else {
        console.log('  Model cache is fresh — skipping fetch.\n');
      }
    }
  } catch {}

  // Check for app updates from GitHub (silent)
  try {
    const repo = getGithubRepo();
    if (repo && isGitRepo()) {
      const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
        headers: { 'User-Agent': 'graham-buffett-agent' }
      });
      if (r.ok) {
        const release = await r.json();
        const remote  = (release.tag_name || '').replace(/^v/, '');
        const local   = ver;
        if (remote && isNewer(local, remote)) {
          console.log('  ⬆  Update available: v' + remote + ' (you have v' + local + ')');
          console.log('  Click "Update App" in the sidebar to install it.\n');
        }
      }
    }
  } catch {}
});
