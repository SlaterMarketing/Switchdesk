// Token use, cost and plan limits per agent and Claude account, kept by day for the Usage page.
'use strict';
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 90;
let file = null;
let data = { days: {}, limits: {} };
let timer = null;

function setBaseDir(dir) {
  file = path.join(dir, 'usage.json');
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  data.days = data.days || {};
  data.limits = data.limits || {};
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => file && fs.promises.writeFile(file, JSON.stringify(data)).catch(() => {}), 1000);
}

// Local calendar day, so "today" means the user's today.
function dayOf(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function record(key, { input = 0, output = 0, cost = 0 } = {}) {
  if (!key) return;
  const day = (data.days[dayOf()] = data.days[dayOf()] || {});
  const r = (day[key] = day[key] || { turns: 0, input: 0, output: 0, cost: 0 });
  r.turns++;
  r.input += Math.max(0, Number(input) || 0);
  r.output += Math.max(0, Number(output) || 0);
  r.cost += Math.max(0, Number(cost) || 0);
  const oldest = dayOf(Date.now() - KEEP_DAYS * 86400000);
  for (const d of Object.keys(data.days)) if (d < oldest) delete data.days[d];
  save();
}

// windows: { short: { pct, resetsAt }, long: { pct, resetsAt } }, as last reported by the agent.
function setLimits(key, windows) {
  if (!key || !windows) return;
  data.limits[key] = { ...windows, at: Date.now() };
  save();
}

// Totals for today, the last 7 days and the last 30 days, per key, plus the latest limits.
function summary() {
  const ranges = { today: dayOf(), week: dayOf(Date.now() - 6 * 86400000), month: dayOf(Date.now() - 29 * 86400000) };
  const keys = {};
  for (const [day, byKey] of Object.entries(data.days)) {
    for (const [key, r] of Object.entries(byKey)) {
      const k = (keys[key] = keys[key] || { today: blank(), week: blank(), month: blank() });
      for (const [name, from] of Object.entries(ranges)) if (day >= from) add(k[name], r);
    }
  }
  return { keys, limits: data.limits };
}
const blank = () => ({ turns: 0, input: 0, output: 0, cost: 0 });
const add = (a, b) => {
  a.turns += b.turns;
  a.input += b.input;
  a.output += b.output;
  a.cost += b.cost;
};

module.exports = { setBaseDir, record, setLimits, summary };
