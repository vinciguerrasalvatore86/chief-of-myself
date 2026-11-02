/* Chief of Myself — logica pura (nessun DOM, nessuna rete).
   Gli stessi calcoli della dashboard su Claude: portfolio, next actions, carico per orizzonte,
   numeri di sintesi, eventi del giorno con importanza, digest per Claude. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CMLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TZ = 'Europe/Rome';
  const todayRome = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  const daysBetween = (from, to) => Math.round((Date.parse(String(to).slice(0, 10)) - Date.parse(String(from).slice(0, 10))) / 864e5);
  const isActive = (p) => p.status === 'In Progress' || p.status === 'Planning';
  const shortName = (n) => String(n || '').replace(/\s*\(.*\)\s*$/, '').replace(/\s+—.*$/, '');
  const horizonOrder = (list) => [...new Set(list)].sort((a, b) => (a === 'Personale') - (b === 'Personale') || a.localeCompare(b));
  const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
  const fmtDateIt = (s) => { if (!s) return ''; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }); };

  /* Ogni progetto non chiuso con orizzonte, programma/fase, giorni dall'ultima review e task aperte. */
  function computePortfolio(projects, tasks, today = todayRome()) {
    const days = (d) => (d ? daysBetween(d, today) : null);
    const byId = new Map(projects.map((p) => [p.id, p]));
    const parentOf = (p) => (p.parent_ids || []).map((i) => byId.get(i)).filter((q) => q && q.type !== 'Project')[0];
    const horizonOf = (p) => { let cur = p, n = 0; while (cur && cur.type !== 'Horizon' && n < 6) { cur = parentOf(cur); n++; } return cur && cur.type === 'Horizon' ? cur.name : 'Personale'; };
    const counts = new Map();
    tasks.forEach((t) => (t.project_ids || []).forEach((id) => {
      const c = counts.get(id) || { open: 0, high: 0, overdue: 0 };
      c.open++;
      if (t.priority === 'High') c.high++;
      if (t.due && String(t.due).slice(0, 10) < today) c.overdue++;
      counts.set(id, c);
    }));
    return projects
      .filter((p) => ['Project', 'Option', 'Ongoing area'].includes(p.type) && p.status !== 'Done' && p.status !== 'Canceled')
      .map((p) => {
        const par = parentOf(p);
        const c = counts.get(p.id) || { open: 0, high: 0, overdue: 0 };
        return {
          project_id: p.id, project_url: p.project_url, name: p.name, horizon: horizonOf(p),
          group: par && par.type !== 'Horizon' ? par.name : '', group_type: par && par.type !== 'Horizon' ? par.type : '',
          type: p.type, status: p.status, health: p.health, stage: p.stage, next_step: p.next_step,
          days_since_review: days(p.last_review), open_tasks: c.open, high_tasks: c.high, overdue_tasks: c.overdue,
        };
      });
  }

  /* Task aperte con progetto e orizzonte, ordinate per priorità e scadenza. */
  function computeNextActions(tasks, portfolio, today = todayRome()) {
    const week = new Date(Date.parse(today) + 7 * 864e5).toISOString().slice(0, 10);
    const byId = new Map(portfolio.map((p) => [p.project_id, p]));
    const rank = { High: 1, Medium: 2, Low: 3 };
    return tasks.map((t) => {
      const p = (t.project_ids || []).map((i) => byId.get(i)).filter(Boolean)[0];
      const due = t.due ? String(t.due).slice(0, 10) : null;
      return {
        task_url: t.task_url, task: t.task, priority: t.priority, status: t.status, due, recurrence: t.recurrence,
        overdue: !!due && due < today, due_soon: !!due && due <= week, due_today: due === today,
        project: p ? p.name : '', horizon: p ? p.horizon : '',
      };
    }).sort((a, b) => (rank[a.priority] || 4) - (rank[b.priority] || 4) || String(a.due || '9999').localeCompare(String(b.due || '9999')));
  }

  function computeByHorizon(nextActions) {
    const out = new Map();
    nextActions.forEach((t) => {
      const h = t.horizon || 'Senza progetto';
      const r = out.get(h) || { horizon: h, High: 0, Medium: 0, Low: 0, None: 0, total: 0 };
      r[t.priority === 'High' || t.priority === 'Medium' || t.priority === 'Low' ? t.priority : 'None']++;
      r.total++;
      out.set(h, r);
    });
    return [...out.values()].sort((a, b) => a.horizon.localeCompare(b.horizon));
  }

  function computeHeadline(nextActions, portfolio, worklog, today = todayRome()) {
    const active = portfolio.filter(isActive);
    const days = new Set(worklog.filter((w) => w.day).map((w) => String(w.day).slice(0, 10)).filter((d) => { const n = daysBetween(d, today); return n >= 0 && n <= 6; }));
    return {
      open_tasks: nextActions.length,
      high_tasks: nextActions.filter((t) => t.priority === 'High').length,
      due_week: nextActions.filter((t) => t.due_soon && !t.overdue).length,
      overdue_tasks: nextActions.filter((t) => t.overdue).length,
      active_projects: active.length,
      paused_projects: portfolio.filter((p) => p.status === 'Paused').length,
      live_projects: portfolio.filter((p) => p.status === 'Live').length,
      stale_projects: active.filter((p) => p.days_since_review === null || p.days_since_review > 14).length,
      log_days_7: days.size,
    };
  }

  /* Importanza dai Meeting Rules: vale la parola chiave più lunga contenuta nel titolo;
     senza regola un evento libero è Bassa, gli altri Normale. */
  function computeDayEvents(events, rules) {
    const rs = (rules || []).filter((r) => r.keyword).map((r) => ({ k: String(r.keyword).toLowerCase().trim(), imp: r.importance || 'Normale' })).filter((r) => r.k).sort((a, b) => b.k.length - a.k.length);
    return (events || [])
      .filter((e) => e.status !== 'cancelled' && !/^\s*(annullato|annullata|canceled|cancelled)\s*:/i.test(String(e.title || '')))
      .map((e) => {
        const t = String(e.title || '').toLowerCase();
        const r = rs.find((x) => t.includes(x.k));
        return { ...e, importance: r ? r.imp : (e.free ? 'Bassa' : 'Normale'), rule: r ? r.k : '' };
      })
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  function attentionItems(portfolio) {
    return portfolio.filter((p) => isActive(p) && (p.health === 'At risk' || p.health === 'Blocked' || p.days_since_review === null || p.days_since_review > 14 || p.overdue_tasks > 0));
  }
  function attentionReasons(p) {
    const why = [];
    if (p.health === 'Blocked') why.push('bloccato');
    if (p.health === 'At risk') why.push('a rischio');
    if (p.overdue_tasks > 0) why.push(p.overdue_tasks + ' task scadute');
    if (p.days_since_review === null) why.push('mai rivisto');
    else if (p.days_since_review > 14) why.push('review ' + p.days_since_review + ' giorni fa');
    return why;
  }

  function openDecisions(decisions, today = todayRome()) {
    return (decisions || [])
      .filter((d) => (d.status === 'Open' || d.status === 'Ready for Review') && d.decision)
      .map((d) => ({ ...d, days_to_review: d.review_on ? daysBetween(today, d.review_on) : null }))
      .sort((a, b) => (a.days_to_review ?? 9999) - (b.days_to_review ?? 9999));
  }

  /* Contesto compatto da incollare in Claude: poche decine di righe invece di centinaia di dati grezzi. */
  const REQUESTS = {
    brief: 'Fammi il briefing di oggi: cosa conta davvero, cosa posso rimandare, quali rischi vedi. Sii diretto e contestami le priorità se non reggono.',
    weekly: 'Facciamo la weekly review: cosa è avanzato, cosa si è fermato, quali progetti rivedere, le tre priorità della prossima settimana. Segnala incongruenze nei dati.',
    context: 'Questo è il mio contesto aggiornato. Aspetta la mia domanda.',
  };
  function buildDigest(ctx, mode = 'brief') {
    const today = ctx.today || todayRome();
    const L = [];
    const fmtT = (s) => new Date(s).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    L.push('# Chief of Myself — contesto del ' + new Date(today + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    if (ctx.headline) {
      const h = ctx.headline;
      L.push('', '## Numeri');
      L.push('- Task aperte: ' + h.open_tasks + ' (High: ' + h.high_tasks + ') · scadute: ' + h.overdue_tasks + ' · in scadenza nei 7 giorni: ' + h.due_week);
      L.push('- Progetti attivi: ' + h.active_projects + ' · in hold: ' + h.paused_projects + ' · live: ' + h.live_projects + ' · senza review da oltre 14 giorni: ' + h.stale_projects);
      L.push('- Giorni con voce nel diario, ultimi 7: ' + h.log_days_7);
    }
    if (ctx.agenda && ctx.agenda.length) {
      L.push('', '## Agenda di oggi');
      ctx.agenda.filter((e) => e.importance !== 'Nascondi').slice(0, 12).forEach((e) => {
        L.push('- ' + (e.all_day ? 'tutto il giorno' : fmtT(e.start) + '–' + fmtT(e.end)) + ' ' + e.title + ' (' + (e.source || '') + (e.importance === 'Alta' ? ', importante' : '') + ')');
      });
    }
    const na = ctx.nextActions || [];
    const urgent = na.filter((t) => t.priority === 'High' || t.overdue).slice(0, 12);
    if (urgent.length) {
      L.push('', '## Task High o scadute');
      urgent.forEach((t) => L.push('- [' + (t.priority || '—') + '] ' + t.task + (t.project ? ' — ' + shortName(t.project) : '') + (t.due ? ' — scad. ' + fmtDateIt(t.due) + (t.overdue ? ' (scaduta)' : '') : '')));
    }
    const soon = na.filter((t) => t.due_soon && !t.overdue && t.priority !== 'High').slice(0, 10);
    if (soon.length) {
      L.push('', '## Altre task in scadenza nei prossimi 7 giorni');
      soon.forEach((t) => L.push('- ' + t.task + (t.project ? ' — ' + shortName(t.project) : '') + ' — ' + fmtDateIt(t.due)));
    }
    const att = attentionItems(ctx.portfolio || []).slice(0, 10);
    if (att.length) {
      L.push('', '## Progetti da guardare');
      att.forEach((p) => L.push('- ' + shortName(p.name) + ' — ' + attentionReasons(p).join(', ') + (p.next_step ? ' — next step: ' + p.next_step : '')));
    }
    const dec = openDecisions(ctx.decisions, today).slice(0, 6);
    if (dec.length) {
      L.push('', '## Decisioni da rivedere');
      dec.forEach((d) => L.push('- ' + d.decision + ' — ' + (d.days_to_review === null ? 'senza data di review' : d.days_to_review < 0 ? 'review scaduta da ' + (-d.days_to_review) + ' giorni' : d.days_to_review === 0 ? 'review oggi' : 'review tra ' + d.days_to_review + ' giorni')));
    }
    const wl = (ctx.worklog || []).slice(0, 5);
    if (wl.length) {
      L.push('', '## Ultime voci del diario');
      wl.forEach((w) => L.push('- ' + fmtDateIt(w.day) + ' — ' + w.entry + (w.impact_level ? ' (impatto ' + w.impact_level + ')' : '')));
    }
    L.push('', '---', REQUESTS[mode] || REQUESTS.brief);
    return L.join('\n');
  }

  return { TZ, todayRome, daysBetween, isActive, shortName, horizonOrder, sum, fmtDateIt, computePortfolio, computeNextActions, computeByHorizon, computeHeadline, computeDayEvents, attentionItems, attentionReasons, openDecisions, buildDigest, REQUESTS };
});
