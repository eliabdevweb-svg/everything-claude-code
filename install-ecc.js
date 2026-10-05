#!/usr/bin/env node
/**
 * install-ecc.js — installe "everything-claude-code" pour Claude Code / Claude Desktop,
 * OpenCode et Antigravity, en convertissant les formats propres à chaque outil.
 *
 *   node install-ecc.js              installe (ou met à jour)
 *   node install-ecc.js --dry-run    affiche ce qui serait fait
 *   node install-ecc.js --uninstall  retire tout ce que ce script a installé
 *   options : --only=claude,opencode,antigravity   --home=<dossier>
 *
 * Règles : rien d'existant n'est écrasé (sauf ce qu'une installation précédente du
 * script a créé), CLAUDE.md et GEMINI.md sont sauvegardés avant modification, et
 * les hooks / serveurs MCP du dépôt ne sont pas installés.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const DRY = args.includes('--dry-run');
const UNINSTALL = args.includes('--uninstall');
const HOME = opt('home') || require('os').homedir();
const ONLY = (opt('only') || 'claude,opencode,antigravity').split(',').map((s) => s.trim());
const REPO = path.resolve(__dirname);
const STATE_DIR = path.join(HOME, '.ecc');
const MANIFEST = path.join(STATE_DIR, 'installed-manifest.json');
const MARK_BEGIN = '<!-- ECC:BEGIN (everything-claude-code, géré par install-ecc.js) -->';
const MARK_END = '<!-- ECC:END -->';

const T = {
  claude: path.join(HOME, '.claude'),
  opencode: path.join(HOME, '.config', 'opencode'),
  antigravitySkills: path.join(HOME, '.gemini', 'config', 'skills'),
  gemini: path.join(HOME, '.gemini', 'GEMINI.md'),
};

// ---------- utilitaires ----------
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(p);
const log = (...m) => console.log(...m);
const prev = exists(MANIFEST) ? JSON.parse(read(MANIFEST)) : { paths: [], blocks: [] };
const owned = new Set(prev.paths.map((p) => path.resolve(p)));
const manifest = { repo: REPO, installedAt: new Date().toISOString(), paths: [], blocks: [] };
const report = { written: 0, skipped: [] };

function parseFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { fm, body: text.slice(m[0].length) };
}
const yamlStr = (s) => JSON.stringify(String(s)); // JSON string = YAML valide
function fmBlock(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) lines.push(`  ${k2}: ${v2}`);
    } else lines.push(`${k}: ${typeof v === 'string' ? yamlStr(v) : v}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function writeFile(dest, content) {
  dest = path.resolve(dest);
  if (exists(dest) && !owned.has(dest)) {
    report.skipped.push(dest);
    return false;
  }
  manifest.paths.push(dest);
  report.written++;
  if (DRY) { log('  [dry] ' + dest); return true; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return true;
}
// un dossier de skill est "à nous" si son SKILL.md l'est ; sinon on ne touche à rien
function skillDirFree(dir) {
  const sk = path.resolve(path.join(dir, 'SKILL.md'));
  if (exists(dir) && !owned.has(sk)) { report.skipped.push(path.resolve(dir)); return false; }
  return true;
}
function copyTree(srcDir, destDir, transform) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) copyTree(s, d, transform);
    else writeFile(d, transform ? transform(e.name, read(s)) : read(s));
  }
}
function upsertBlock(file, block) {
  const body = `${MARK_BEGIN}\n${block.trim()}\n${MARK_END}`;
  const cur = exists(file) ? read(file) : '';
  const re = new RegExp(`\\n*${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}\\n*`);
  const base = cur.replace(re, '\n').trimEnd();
  const next = (base ? base + '\n\n' : '') + body + '\n';
  manifest.blocks.push(path.resolve(file));
  if (DRY) { log('  [dry] bloc ECC -> ' + file); return; }
  if (cur && !cur.includes(MARK_BEGIN)) backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
}
function removeBlock(file) {
  if (!exists(file)) return;
  const re = new RegExp(`\\n*${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}\\n*`);
  const cur = read(file);
  if (!cur.includes(MARK_BEGIN)) return;
  const next = cur.replace(re, '\n').trimEnd();
  if (!DRY) fs.writeFileSync(file, next ? next + '\n' : '', 'utf8');
  log('  bloc ECC retiré de ' + file);
}
function backup(file) {
  const dir = path.join(STATE_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(file)}.${stamp}.bak`);
  fs.copyFileSync(file, dest);
  log('  sauvegarde : ' + dest);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- inventaire du dépôt ----------
const DESC = {
  'build-fix': 'Incrementally fix build and TypeScript errors: run the build, group errors by file, fix one at a time and re-run.',
  checkpoint: 'Create, verify or list named workflow checkpoints (git state + test results) to compare progress over a session.',
  'code-review': 'Security and quality review of uncommitted changes (git diff): secrets, injection, error handling, size, tests.',
  eval: 'Eval-driven development: define, check, report or list evals (expected behaviours) for a feature.',
  learn: 'Extract reusable patterns from the current session and save them as learned skills.',
  orchestrate: 'Run a sequential multi-agent workflow (feature, bugfix, refactor, security) with handoffs between agents.',
  'refactor-clean': 'Safely find and remove dead code and unused dependencies (knip, depcheck, ts-prune) with test verification.',
  'test-coverage': 'Analyse test coverage, find under-tested files and generate the missing tests up to 80%.',
  'update-codemaps': 'Scan the codebase and regenerate token-lean architecture codemaps (codemaps/*.md).',
  'update-docs': 'Sync documentation from sources of truth (package.json scripts, .env.example) and flag stale docs.',
  verify: 'Run a full verification pass (build, types, lint, tests, secrets, console.log, git status) and report readiness.',
  'eval-harness': 'Formal evaluation framework for AI coding sessions (eval-driven development, pass@k, grader types). Use when defining success criteria or measuring agent reliability.',
  'verification-loop': 'Comprehensive verification loop after a feature or significant change: build, types, lint, tests, security, diff review.',
};
const SKIP_SKILLS = new Set(['project-guidelines-example']);
const CMD_RENAME = { plan: 'ecc-plan', tdd: 'ecc-tdd', 'code-review': 'ecc-code-review' }; // collisions (/plan intégré, skills existants)

const agents = fs.readdirSync(path.join(REPO, 'agents')).filter((f) => f.endsWith('.md')).map((f) => {
  const { fm, body } = parseFm(read(path.join(REPO, 'agents', f)));
  return { name: fm.name || f.replace(/\.md$/, ''), description: fm.description, tools: (fm.tools || '').split(',').map((t) => t.trim()).filter(Boolean), body };
});
const commands = fs.readdirSync(path.join(REPO, 'commands')).filter((f) => f.endsWith('.md')).map((f) => {
  const id = f.replace(/\.md$/, '');
  const { fm, body } = parseFm(read(path.join(REPO, 'commands', f)));
  return { id, name: CMD_RENAME[id] || id, description: fm.description || DESC[id] || `everything-claude-code command: ${id}`, body };
});
const skills = fs.readdirSync(path.join(REPO, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP_SKILLS.has(d.name)).map((d) => {
  const { fm } = parseFm(read(path.join(REPO, 'skills', d.name, 'SKILL.md')));
  return { id: d.name, name: 'ecc-' + d.name, description: fm.description || DESC[d.name] };
});

// réécrit les références internes vers les noms installés
function rewriteRefs(text, mode) {
  let t = text;
  // /plan, /tdd, /code-review -> noms renommés (commande ou skill selon l'outil)
  t = t.replace(/(^|[\s`(])\/(plan|tdd|code-review)\b(?![-/\w])/gm, (m, p, c) => `${p}/${CMD_RENAME[c]}`);
  // chemin de script relatif du dépôt -> chemin absolu
  const scripts = path.join(REPO, 'scripts').replace(/\\/g, '/');
  t = t.replace(/node scripts\//g, `node "${scripts}/`).replace(/(node "[^"\n]*?\.js)(\s|$)/g, '$1"$2');
  for (const s of skills) t = t.split(`skills/${s.id}/`).join(`skills/${s.name}/`);
  if (mode === 'opencode') t = t.split('~/.claude/agents/').join('~/.config/opencode/agents/').split('~/.claude/skills/').join('~/.config/opencode/skills/');
  if (mode === 'antigravity') {
    t = t.replace(/(^|[\s`(])\/(ecc-plan|ecc-tdd|ecc-code-review|[a-z][a-z-]+)\b/gm, (m, p, c) => {
      const cmd = commands.find((x) => x.name === c || x.id === c);
      return cmd ? `${p}skill ecc-${cmd.id}` : m;
    });
    t = t.split('~/.claude/agents/').join('~/.gemini/config/skills/ecc-').split('~/.claude/skills/').join('~/.gemini/config/skills/');
  }
  return t;
}
function skillMd(s, raw) {
  const { fm, body } = parseFm(raw);
  const out = { name: s.name, description: s.description };
  for (const [k, v] of Object.entries(fm)) if (!['name', 'description'].includes(k)) out[k] = v;
  return fmBlock(out) + body;
}

// ---------- skill "ecc-dev-rules" construit à partir de rules/ ----------
const RULE_FILES = fs.readdirSync(path.join(REPO, 'rules')).filter((f) => f.endsWith('.md') && f !== 'hooks.md');
function rulesSkill(dest, mode) {
  const dir = path.join(dest, 'ecc-dev-rules');
  if (!skillDirFree(dir)) return;
  const list = RULE_FILES.map((f) => `- \`references/${f}\` — ${read(path.join(REPO, 'rules', f)).split('\n').find((l) => l.startsWith('# '))?.slice(2) || f}`).join('\n');
  const body = `# Règles de dev everything-claude-code

Règles de développement du dépôt everything-claude-code, chargées à la demande
(et non en permanence) pour ne pas imposer TDD et immutabilité aux tâches de contenu ou de design.

À charger pour un travail de code dans un projet (feature, refactor, revue, commit).
Lis seulement le fichier utile :

${list}

Les noms de modèles cités dans \`performance.md\` datent de la création du dépôt ; utilise les modèles actuels.
${mode === 'antigravity' ? '\nDans Antigravity, les « agents » mentionnés sont installés comme skills `ecc-<nom>` (ex. `ecc-planner`).\n' : ''}`;
  writeFile(path.join(dir, 'SKILL.md'), fmBlock({ name: 'ecc-dev-rules', description: 'everything-claude-code development rules (security, coding style, testing/TDD, git workflow, agent orchestration, design patterns, performance). Load before coding, reviewing or committing in a software project.' }) + body);
  for (const f of RULE_FILES) writeFile(path.join(dir, 'references', f), rewriteRefs(read(path.join(REPO, 'rules', f)), mode));
}

function installSkills(dest, mode) {
  for (const s of skills) {
    const dir = path.join(dest, s.name);
    if (!skillDirFree(dir)) continue;
    copyTree(path.join(REPO, 'skills', s.id), dir, (fname, txt) => fname === 'SKILL.md' ? rewriteRefs(skillMd(s, txt), mode) : txt);
  }
  rulesSkill(dest, mode);
}

// ---------- cibles ----------
function installClaude() {
  log('\n▶ Claude Code / Claude Desktop (onglet Code) -> ' + T.claude);
  for (const a of agents) writeFile(path.join(T.claude, 'agents', `${a.name}.md`), rewriteRefs(read(path.join(REPO, 'agents', `${a.name}.md`)), 'claude'));
  for (const c of commands) writeFile(path.join(T.claude, 'commands', `${c.name}.md`), fmBlock({ description: c.description }) + rewriteRefs(c.body, 'claude'));
  installSkills(path.join(T.claude, 'skills'), 'claude');
  upsertBlock(path.join(T.claude, 'CLAUDE.md'), routing('claude'));
}

function installOpenCode() {
  log('\n▶ OpenCode -> ' + T.opencode);
  for (const a of agents) {
    const has = (t) => a.tools.includes(t);
    const tools = {};
    if (!has('Write')) tools.write = false;
    if (!has('Edit')) tools.edit = false;
    if (!has('Bash')) tools.bash = false;
    const fm = { description: a.description, mode: 'subagent' };
    if (Object.keys(tools).length) fm.tools = tools;
    writeFile(path.join(T.opencode, 'agents', `${a.name}.md`), fmBlock(fm) + rewriteRefs(a.body, 'opencode'));
  }
  for (const c of commands) writeFile(path.join(T.opencode, 'commands', `${c.name}.md`), fmBlock({ description: c.description }) + rewriteRefs(c.body, 'opencode'));
  installSkills(path.join(T.opencode, 'skills'), 'opencode');
  // pas d'AGENTS.md global : OpenCode lit alors ~/.claude/CLAUDE.md, qui contient le bloc de routage
}

function installAntigravity() {
  log('\n▶ Antigravity -> ' + T.antigravitySkills);
  installSkills(T.antigravitySkills, 'antigravity');
  for (const a of agents) {
    const name = 'ecc-' + a.name;
    const dir = path.join(T.antigravitySkills, name);
    if (!skillDirFree(dir)) continue;
    writeFile(path.join(dir, 'SKILL.md'), fmBlock({ name, description: a.description }) + `> Rôle d'agent everything-claude-code (\`${a.name}\`) : adopte ce rôle et suis ces consignes.\n\n` + rewriteRefs(a.body, 'antigravity'));
  }
  for (const c of commands) {
    const name = 'ecc-' + c.id;
    const dir = path.join(T.antigravitySkills, name);
    if (!skillDirFree(dir)) continue;
    writeFile(path.join(dir, 'SKILL.md'), fmBlock({ name, description: c.description }) + `> Workflow everything-claude-code (ancienne commande \`/${c.id}\`). Les arguments sont la demande de l'utilisateur.\n\n` + rewriteRefs(c.body, 'antigravity').replace(/\$ARGUMENTS/g, "la demande de l'utilisateur"));
  }
  upsertBlock(T.gemini, routing('antigravity'));
}

function routing(mode) {
  const cmd = (id) => mode === 'antigravity' ? `\`ecc-${id}\`` : `\`/${CMD_RENAME[id] || id}\``;
  const ag = (n) => mode === 'antigravity' ? `\`ecc-${n}\`` : `\`${n}\``;
  return `## Boîte à outils everything-claude-code (ECC)

Installée depuis ${REPO.replace(/\\/g, '/')}. ${mode === 'antigravity' ? 'Dans Antigravity, agents et commandes sont des skills préfixés `ecc-`.' : 'Agents, commandes et skills préfixés `ecc-`.'}
Ces outils servent aux **projets de code**. Pour le contenu, le design ou la stratégie, ne les charge pas.

| Besoin | ${mode === 'antigravity' ? 'Skill' : 'Commande / agent'} |
|---|---|
| Planifier une feature ou un refactor avant de coder (attendre ma validation) | ${cmd('plan')} → ${ag('planner')} |
| Décision d'architecture | ${ag('architect')} |
| Écrire les tests d'abord | ${cmd('tdd')} → ${ag('tdd-guide')} |
| Revue des changements non commités | ${cmd('code-review')} → ${ag('code-reviewer')} |
| Code touchant auth, entrées utilisateur, secrets, paiement | ${ag('security-reviewer')}, skill \`ecc-security-review\` |
| Build ou TypeScript en échec | ${cmd('build-fix')} → ${ag('build-error-resolver')} |
| Tests E2E Playwright | ${cmd('e2e')} → ${ag('e2e-runner')} |
| Nettoyage de code mort | ${cmd('refactor-clean')} → ${ag('refactor-cleaner')} |
| Vérification complète avant livraison | ${cmd('verify')}, skill \`ecc-verification-loop\` |
| Docs et codemaps | ${cmd('update-docs')}, ${cmd('update-codemaps')} → ${ag('doc-updater')} |
| Règles de dev (sécurité, style, tests, git) | skill \`ecc-dev-rules\` |

En cas de doublon avec un skill existant (\`coding-standards\`, \`security\`, \`testing\`, \`git-workflow\`), les skills existants restent prioritaires ; les \`ecc-*\` complètent.`;
}

// ---------- désinstallation ----------
function uninstall() {
  log('Désinstallation (manifeste : ' + MANIFEST + ')');
  const files = prev.paths.slice().sort((a, b) => b.length - a.length);
  for (const f of files) if (exists(f)) { if (!DRY) fs.unlinkSync(f); }
  // supprime les dossiers devenus vides
  const dirs = [...new Set(files.map((f) => path.dirname(f)))].sort((a, b) => b.length - a.length);
  for (let d of dirs) {
    while (d.length > HOME.length + 1 && exists(d) && fs.readdirSync(d).length === 0) { if (!DRY) fs.rmdirSync(d); else break; d = path.dirname(d); }
  }
  for (const b of prev.blocks || []) removeBlock(b);
  if (!DRY && exists(MANIFEST)) fs.unlinkSync(MANIFEST);
  log(`${files.length} fichiers retirés.`);
}

// ---------- main ----------
if (UNINSTALL) { uninstall(); process.exit(0); }
log(`everything-claude-code -> ${HOME}${DRY ? '  (dry-run)' : ''}`);
if (ONLY.includes('claude')) installClaude();
if (ONLY.includes('opencode')) installOpenCode();
if (ONLY.includes('antigravity')) installAntigravity();
// les fichiers d'une installation précédente qui ne sont plus produits sont retirés
const now = new Set(manifest.paths);
for (const p of prev.paths) if (!now.has(path.resolve(p)) && exists(p) && ONLY.length === 3) { if (!DRY) fs.unlinkSync(p); }
if (!DRY) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2)); }
log(`\n✔ ${report.written} fichiers écrits.`);
if (report.skipped.length) {
  log(`⚠ ${report.skipped.length} éléments déjà présents, laissés intacts :`);
  for (const s of [...new Set(report.skipped)]) log('   - ' + s);
}
log('Hooks et serveurs MCP du dépôt : non installés (voir README).');
