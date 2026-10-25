/*
 * Which background jobs have something to do, kept in memory.
 *
 * The database (Neon, free plan) goes to sleep after 5 quiet minutes and only counts compute time while
 * awake. A job that looked in the database every couple of minutes "just in case" kept it awake day and
 * night. Now each job looks only while there is work: the code that creates work marks it here, and the
 * job clears the mark once it finds nothing left. Every mark starts "on", so after a restart each job
 * looks once.
 */
const hints = new Map(); // name -> { on: boolean, at: time of the last mark }
const GRACE_MS = 5 * 60 * 1000; // work marked moments ago may not be visible to the job's query yet

function mark(name) { hints.set(name, { on: true, at: Date.now() }); }
function pending(name) { const h = hints.get(name); return !h || h.on; }
function done(name) {
  const h = hints.get(name);
  if (h && h.on && Date.now() - h.at < GRACE_MS) return;
  hints.set(name, { on: false, at: h ? h.at : 0 });
}
function snapshot() { return Object.fromEntries([...hints].map(([k, v]) => [k, v.on])); }

module.exports = { mark, pending, done, snapshot };
