/*
 * Context Gauge — Studio Dashboard Frontend.
 * Auto-follows Antigravity's active conversation via window.sidecar.conversationId
 * and syncs light/dark theme from /preload.js host CSS variables.
 */
(() => {
  const POLL_MS = 1500;
  const HIDDEN_POLL_MS = 10000;
  const SESSIONS_POLL_MS = 8000;
  const STORAGE_KEY = 'agy_context_monitor_prefs_v1';

  const $ = (id) => document.getElementById(id);

  // Arc geometry for 240-degree studio gauge centered at (70, 68), radius 50.
  const ARC_CX = 70;
  const ARC_CY = 68;
  const ARC_R = 50;
  const ARC_START_DEG = 150;
  const ARC_SWEEP_DEG = 240;

  const defaultPrefs = { warnPct: 60, critPct: 80, chartScope: 'window', showGuide: true, showAdvanced: false, showTips: true };
  let prefs = loadPrefs();

  const state = {
    pinnedConv: null,      // null = follow active conversation automatically
    activeConv: '',
    workspaceUri: '',
    etag: '',
    uiVersion: '',         // auto-reload if a newer UI bundle is deployed
    payload: null,
    sessions: [],
    lastSessionsAt: 0,
    lastOkAt: 0,
    lastRenderedConv: '',
    lastStepSig: '',
    lastChartAnimKey: '',
    hiddenAt: 0,
    syncFlashTimer: null,
    stepBumpTimer: null,
    highlightChartTurn: null,
    clearChartHighlight: null,
    pollTimer: null,
  };

  window.sidecar?.getWorkspaceUris?.().then((uris) => {
    const first = Array.isArray(uris) && uris[0] ? uris[0] : '';
    if (first && first !== state.workspaceUri) {
      state.workspaceUri = first;
      state.etag = '';
    }
  });
  window.sidecar?.onWorkspaceChange?.((uris) => {
    const next = Array.isArray(uris) && uris[0] ? uris[0] : '';
    if (next !== state.workspaceUri) {
      state.workspaceUri = next;
      state.etag = '';
    }
  });

  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        warnPct: clamp(Number(raw.warnPct) || defaultPrefs.warnPct, 20, 90),
        critPct: clamp(Number(raw.critPct) || defaultPrefs.critPct, 30, 98),
        chartScope: raw.chartScope === 'all' ? 'all' : 'window',
        showGuide: typeof raw.showGuide === 'boolean' ? raw.showGuide : true,
        showAdvanced: typeof raw.showAdvanced === 'boolean' ? raw.showAdvanced : false,
        showTips: typeof raw.showTips === 'boolean' ? raw.showTips : true,
      };
    } catch {
      return { ...defaultPrefs };
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage restrictions.
    }
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // ---------- Host Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f6f7f9)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.45 ? 'dark' : 'light';
  }

  syncScheme();
  const themeObserver = new MutationObserver(syncScheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener('change', syncScheme);

  // ---------- Helpers ----------
  const urlParams = new URLSearchParams(location.search);

  function cleanChatTitle(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/@\[conversation:"([^"]+)"\]/gi, '$1')
      .replace(/@\[[^\]:]+:"?([^"\]]+)"?\]/g, '$1')
      .replace(/@\[([^\]]+)\]/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveHostConv() {
    return window.sidecar?.conversationId || urlParams.get('conversationId') || '';
  }

  function targetConv() {
    return state.pinnedConv || resolveHostConv();
  }

  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
    if (abs >= 100_000) return `${Math.round(v / 1_000)}K`;
    if (abs >= 10_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return `${Math.round(v)}`;
  }

  function fmtExact(n) {
    return Math.round(Number(n) || 0).toLocaleString();
  }

  function fmtDelta(n) {
    const v = Number(n) || 0;
    const sign = v > 0 ? '+' : '';
    return `${sign}${fmtTokens(v)}`;
  }

  function fmtGaugePct(v) {
    const n = Number(v) || 0;
    if (n <= 0) return '0%';
    if (n < 1) return '<1%';
    return `${Math.round(n)}%`;
  }

  function fmtTimeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function polar(cx, cy, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx, cy, r, startDeg, sweepDeg) {
    const start = polar(cx, cy, r, startDeg);
    const end = polar(cx, cy, r, startDeg + sweepDeg);
    const largeArc = sweepDeg > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  // Initialize static gauge arc track once.
  const arcD = describeArc(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, ARC_SWEEP_DEG);
  const trackEl = $('ring-track');
  const fillEl = $('ring-fill');
  trackEl.setAttribute('d', arcD);
  fillEl.setAttribute('d', arcD);
  const ARC_LEN = fillEl.getTotalLength();
  fillEl.style.strokeDasharray = `${ARC_LEN.toFixed(2)}`;
  fillEl.style.strokeDashoffset = `${ARC_LEN.toFixed(2)}`;

  function positionTick(lineEl, pct) {
    const deg = ARC_START_DEG + (clamp(pct, 0, 100) / 100) * ARC_SWEEP_DEG;
    const p1 = polar(ARC_CX, ARC_CY, ARC_R - 8, deg);
    const p2 = polar(ARC_CX, ARC_CY, ARC_R + 8, deg);
    lineEl.setAttribute('x1', p1.x.toFixed(2));
    lineEl.setAttribute('y1', p1.y.toFixed(2));
    lineEl.setAttribute('x2', p2.x.toFixed(2));
    lineEl.setAttribute('y2', p2.y.toFixed(2));
  }

  const CHAT_HUES = [198, 152, 262, 26, 330, 218, 174, 42];
  function chatHue(convId) {
    if (!convId) return 198;
    let h = 0;
    for (let i = 0; i < convId.length; i++) {
      h = (h * 31 + convId.charCodeAt(i)) >>> 0;
    }
    return CHAT_HUES[h % CHAT_HUES.length];
  }

  function resolveChatTitle(convId) {
    if (!convId) return 'Waiting for an open chat…';
    if (state.payload && state.payload.conversationId === convId && state.payload.title) {
      return cleanChatTitle(state.payload.title) || `Chat #${convId.slice(0, 6)}`;
    }
    const found = (state.sessions || []).find((s) => s.conversationId === convId);
    if (found?.title) {
      return cleanChatTitle(found.title) || `Chat #${convId.slice(0, 6)}`;
    }
    return `Chat #${convId.slice(0, 6)}`;
  }

  function triggerChatSyncFlash(label = '✓ Synced') {
    const card = $('chat-link-card');
    const pill = $('chat-sync-pill');
    if (!card) return;
    clearTimeout(state.syncFlashTimer);
    card.classList.remove('sync-flash');
    void card.offsetWidth;
    card.classList.add('sync-flash');
    if (pill) {
      pill.textContent = label;
      pill.classList.remove('hidden');
    }
    state.syncFlashTimer = setTimeout(() => {
      card.classList.remove('sync-flash');
      if (pill) pill.classList.add('hidden');
    }, 1800);
  }

  function triggerStepBump() {
    const hero = document.querySelector('.hero-card');
    const deltaTile = $('stat-delta')?.closest('.stat-tile');
    const turnsTile = $('stat-turns')?.closest('.stat-tile');
    clearTimeout(state.stepBumpTimer);
    for (const el of [hero, deltaTile, turnsTile]) {
      if (!el) continue;
      el.classList.remove('step-bump');
      void el.offsetWidth;
      el.classList.add('step-bump');
    }
    state.stepBumpTimer = setTimeout(() => {
      for (const el of [hero, deltaTile, turnsTile]) {
        el?.classList.remove('step-bump');
      }
    }, 800);
  }

  function animateNumber(el, targetVal, formatter, durationMs = 380) {
    if (!el) return;
    const to = Number(targetVal) || 0;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (el._animRaf) {
      cancelAnimationFrame(el._animRaf);
      el._animRaf = 0;
    }
    const from = Number.isFinite(el._numVal) ? el._numVal : to;
    if (reduced || Math.abs(to - from) < 0.01 || durationMs <= 0) {
      el._numVal = to;
      el.textContent = formatter(to);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = clamp((now - start) / durationMs, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      el._numVal = val;
      el.textContent = formatter(val);
      if (t < 1) {
        el._animRaf = requestAnimationFrame(step);
      } else {
        el._numVal = to;
        el.textContent = formatter(to);
        el._animRaf = 0;
      }
    };
    el._animRaf = requestAnimationFrame(step);
  }

  function renderChatLink() {
    const card = $('chat-link-card');
    if (!card) return;
    const active = resolveHostConv();
    const conv = targetConv();
    const isPinned = Boolean(state.pinnedConv && state.pinnedConv !== active);
    const d = state.payload && state.payload.conversationId === conv ? state.payload.data : null;
    const hue = chatHue(conv);

    card.style.setProperty('--chat-hue', String(hue));
    card.classList.toggle('is-pinned', isPinned);

    const shortId = conv ? `#${conv.slice(0, 6)}` : '—';
    const title = resolveChatTitle(conv);
    const titleEl = $('chat-link-title');
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.title = title;
    }

    const chipEl = $('chat-id-chip');
    if (chipEl) chipEl.textContent = conv ? `Chat ${shortId}` : 'No chat';

    const badgeEl = $('chat-link-badge');
    const stateEl = $('chat-link-state');
    if (stateEl) {
      if (isPinned) {
        stateEl.textContent = '📌 Inspecting other chat (not left pane)';
        if (badgeEl) {
          badgeEl.dataset.tipTitle = 'Pinned to Another Chat';
          badgeEl.dataset.tipBody = 'You picked an older chat below, so this panel is NOT tracking the chat on the left right now. Click "← Back to Open Chat" to reconnect.';
        }
      } else if (d?.current?.isActiveTurn) {
        stateEl.textContent = '⚡ AI working in open chat…';
        if (badgeEl) {
          badgeEl.dataset.tipTitle = 'Connected to Your Open Chat';
          badgeEl.dataset.tipBody = 'Antigravity is actively taking AI steps right now in the chat you have open on the left.';
        }
      } else {
        stateEl.textContent = '← Linked to open chat';
        if (badgeEl) {
          badgeEl.dataset.tipTitle = 'Connected to Your Open Chat';
          badgeEl.dataset.tipBody = 'This panel automatically follows whichever chat you open on the left side of Antigravity.';
        }
      }
    }

    const promptEl = $('chat-link-prompt');
    if (promptEl) {
      const snippet = d?.current?.lastUserSnippet || '';
      if (snippet) {
        promptEl.textContent = `Latest prompt: “${snippet}”`;
        promptEl.classList.remove('hidden');
      } else if (conv) {
        promptEl.textContent = 'New chat — send a prompt on the left to start tracking memory.';
        promptEl.classList.remove('hidden');
      } else {
        promptEl.classList.add('hidden');
      }
    }
  }

  // ---------- Render Dashboard ----------
  function render() {
    renderChatLink();
    const conv = targetConv();
    const active = resolveHostConv();
    const isPinned = Boolean(state.pinnedConv && state.pinnedConv !== active);
    const p = state.payload;
    if (!p || !p.found || !p.data || !p.data.hasData) {
      $('dashboard').classList.add('hidden');
      $('empty-state').classList.remove('hidden');
      $('live-pill')?.classList.remove('working');
      $('live-pill')?.classList.toggle('pinned', isPinned);
      if (conv) {
        const title = resolveChatTitle(conv);
        $('empty-title').textContent = `Connected to "${title}" (#${conv.slice(0, 6)})`;
        $('empty-sub').textContent = 'Waiting for first AI reply — send a prompt on the left and live memory numbers will show up here.';
      } else {
        $('empty-title').textContent = 'Waiting for an open chat…';
        $('empty-sub').textContent = 'Send a prompt in any Antigravity chat and memory numbers will show up here automatically.';
      }
      if (conv && conv !== state.lastRenderedConv) {
        state.lastRenderedConv = conv;
        state.lastStepSig = '';
        triggerChatSyncFlash('✓ Switched chat');
      }
      return;
    }

    $('empty-state').classList.add('hidden');
    $('dashboard').classList.remove('hidden');

    const d = p.data;
    const cur = d.current;
    const tot = d.totals;

    const prevConv = state.lastRenderedConv;
    const stepSig = `${conv}:${tot.turnCount}:${tot.stepCount}:${cur.exactContextTokens}`;
    if (conv !== prevConv) {
      state.lastRenderedConv = conv;
      state.lastStepSig = stepSig;
      state.lastChartAnimKey = '';
      if ($('gauge-pct')) $('gauge-pct')._numVal = 0;
      if ($('val-used')) $('val-used')._numVal = 0;
      triggerChatSyncFlash(prevConv ? '✓ Switched chat' : '✓ Linked');
    } else if (state.lastStepSig && state.lastStepSig !== stepSig) {
      state.lastStepSig = stepSig;
      triggerStepBump();
    }

    const livePill = $('live-pill');
    if (livePill) {
      livePill.classList.toggle('pinned', isPinned);
      livePill.classList.toggle('working', Boolean(cur.isActiveTurn && !isPinned));
    }
    const workPill = $('working-pill');
    if (workPill) {
      workPill.classList.toggle('hidden', !cur.isActiveTurn);
    }

    const limit = d.model.contextLimit || 256_000;
    const used = cur.exactContextTokens;
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    const clampedPct = clamp(pct, 0, 100);
    const remaining = Math.max(0, limit - used);

    const warnPct = prefs.warnPct;
    const critPct = Math.max(warnPct + 5, prefs.critPct);

    let level = 'healthy';
    let statusLabel = 'Healthy';
    if (pct >= critPct) {
      level = 'crit';
      statusLabel = 'Almost full';
    } else if (pct >= warnPct) {
      level = 'warn';
      statusLabel = 'Getting full';
    }

    // Steps-until-cleanup estimate: space left / average growth per step
    // over the last 8 steps of the current window (shrinking steps count as 0).
    const windowTurns = d.turns.slice(d.epochStartTurn);
    const recent = windowTurns.slice(1).slice(-8);
    const avgGrowth = recent.length
      ? recent.reduce((s, t) => s + Math.max(0, t.deltaTokens || 0), 0) / recent.length
      : 0;
    const hasEta = recent.length >= 3 && avgGrowth >= 1;
    const stepsLeft = hasEta ? Math.floor(remaining / avgGrowth) : null;

    // One-line status summary at the very top
    const latestTurn = d.turns.length ? d.turns[d.turns.length - 1] : null;
    const justSummarized = Boolean(cur.justCompacted || latestTurn?.compacted);
    const statusBanner = $('status-banner');
    const statusMain = $('status-main');
    const statusSub = $('status-sub');
    const copyCompactBtn = $('btn-copy-compact');

    if (justSummarized) {
      statusBanner.className = 'status-banner summary has-tip';
      statusMain.textContent = 'Memory was just summarized';
      statusSub.textContent = ' · older details may be fuzzy now';
      statusBanner.dataset.tipTitle = 'Just Summarized';
      statusBanner.dataset.tipBody = 'Older parts of this chat were condensed to free up memory. Exact wording from early turns may be shorter now.';
      copyCompactBtn.classList.add('hidden');
    } else if (pct >= critPct || (hasEta && stepsLeft <= 3)) {
      statusBanner.className = 'status-banner crit has-tip';
      statusMain.textContent = 'Almost full';
      statusSub.textContent = ' · wrap up, or type /compact, or start a new chat';
      statusBanner.dataset.tipTitle = 'Almost Full';
      statusBanner.dataset.tipBody = 'Close to the memory ceiling. Typing /compact (or opening a new chat for a fresh task) keeps you in control.';
      copyCompactBtn.classList.remove('hidden');
    } else if (pct >= warnPct) {
      statusBanner.className = 'status-banner warn has-tip';
      statusMain.textContent = 'Getting full';
      statusSub.textContent = ' · good time to finish this task';
      statusBanner.dataset.tipTitle = 'Getting Full';
      statusBanner.dataset.tipBody = `${fmtTokens(remaining)} left before auto-cleanup. Finish your current step cleanly before starting something huge.`;
      copyCompactBtn.classList.add('hidden');
    } else if (hasEta && stepsLeft <= 15) {
      statusBanner.className = 'status-banner soon has-tip';
      statusMain.textContent = stepsLeft <= 0
        ? 'Room for 1 more step'
        : `Room for about ${stepsLeft} more step${stepsLeft === 1 ? '' : 's'}`;
      statusSub.textContent = '';
      statusBanner.dataset.tipTitle = 'Room Left';
      statusBanner.dataset.tipBody = `${fmtTokens(remaining)} left at your recent pace of about ${fmtTokens(avgGrowth)} per step.`;
      copyCompactBtn.classList.add('hidden');
    } else {
      statusBanner.className = 'status-banner healthy has-tip';
      statusMain.textContent = 'Plenty of room';
      statusSub.textContent = hasEta ? ` · about ${stepsLeft} steps left` : '';
      statusBanner.dataset.tipTitle = 'Plenty of Room';
      statusBanner.dataset.tipBody = 'Lots of short-term memory left. Keep working normally.';
      copyCompactBtn.classList.add('hidden');
    }

    const exactBadge = $('exact-badge');
    if (cur.justCompacted) {
      exactBadge.textContent = 'Summarized (est.)';
      exactBadge.className = 'exact-badge est has-tip';
      exactBadge.dataset.tipTitle = 'After-Cleanup Estimate';
      exactBadge.dataset.tipBody = 'Your /compact summary is saved! Showing base setup + summary size until your next message.';
    } else {
      exactBadge.textContent = 'Measured by server';
      exactBadge.className = 'exact-badge has-tip';
      exactBadge.dataset.tipTitle = 'Measured by Server';
      exactBadge.dataset.tipBody = "Exact memory numbers reported by Antigravity's server — not a rough word-count guess.";
    }

    // Radial Ring Gauge
    const offset = ARC_LEN * (1 - clampedPct / 100);
    fillEl.style.strokeDashoffset = `${offset.toFixed(2)}`;
    fillEl.className.baseVal = `ring-fill ${level}`;
    const tipCircle = $('ring-tip');
    if (tipCircle) {
      if (clampedPct > 0.5) {
        const tipDeg = ARC_START_DEG + (clampedPct / 100) * ARC_SWEEP_DEG;
        const tipPt = polar(ARC_CX, ARC_CY, ARC_R, tipDeg);
        tipCircle.setAttribute('cx', tipPt.x.toFixed(2));
        tipCircle.setAttribute('cy', tipPt.y.toFixed(2));
        tipCircle.setAttribute('visibility', 'visible');
        tipCircle.className.baseVal = `ring-tip ${level}`;
      } else {
        tipCircle.setAttribute('visibility', 'hidden');
      }
    }
    positionTick($('tick-warn'), warnPct);
    positionTick($('tick-crit'), critPct);

    animateNumber($('gauge-pct'), pct, fmtGaugePct);
    const gStatus = $('gauge-status');
    gStatus.textContent = statusLabel;
    gStatus.className = `gauge-status ${level}`;

    // Hero Numeric Readout
    $('model-badge').textContent = d.model.displayName;
    $('model-badge').dataset.tipBody = d.model.raw
      ? `The AI model that handled the last step (${d.model.raw}). Different models have different memory sizes.`
      : 'Antigravity has not recorded the model name in this chat log yet. Memory numbers are still exact.';

    const ceilingBadge = $('ceiling-badge');
    ceilingBadge.textContent = d.model.ceilingBadge || `Auto (est. ${d.model.windowLabel})`;
    ceilingBadge.dataset.tipTitle = 'Memory Ceiling';
    ceilingBadge.dataset.tipBody = d.model.isLearnedCeiling
      ? 'Learned from when Antigravity last summarized this chat.'
      : "Best guess of this model's memory size. If Antigravity cleans up earlier or later than this, the guess adjusts automatically.";

    animateNumber($('val-used'), used, fmtTokens);
    $('val-limit').textContent = fmtTokens(limit);
    $('val-remaining').textContent = `${fmtTokens(remaining)} left`;
    $('val-projected').classList.add('hidden');

    const etaEl = $('val-eta');
    if (hasEta) {
      etaEl.textContent = stepsLeft <= 0
        ? 'Auto-cleanup due on the next step'
        : `≈ ${stepsLeft} step${stepsLeft === 1 ? '' : 's'} until auto-cleanup`;
      etaEl.dataset.tipBody =
        `${fmtTokens(remaining)} left ÷ about ${fmtTokens(avgGrowth)} added per step ` +
        `(average of the last ${recent.length} steps). Reading a huge file or command output can use several steps' worth at once.`;
      etaEl.classList.toggle('eta-now', stepsLeft <= 2);
      etaEl.classList.toggle('eta-soon', stepsLeft > 2 && stepsLeft <= 8);
      etaEl.classList.remove('hidden');
    } else {
      etaEl.classList.add('hidden');
    }

    $('chip-cached').textContent = fmtTokens(cur.latestCacheReadTokens);
    $('chip-fresh').textContent = fmtTokens(cur.latestInputTokens);
    $('chip-out').textContent = fmtTokens(cur.latestOutputTokens);

    // Segmented Linear Bar
    const cachedPct = limit > 0 ? clamp((cur.latestCacheReadTokens / limit) * 100, 0, 100) : 0;
    const freshPct = limit > 0 ? clamp((cur.latestInputTokens / limit) * 100, 0, 100 - cachedPct) : 0;
    $('bar-cached').style.width = `${cachedPct.toFixed(2)}%`;
    $('bar-fresh').style.width = `${freshPct.toFixed(2)}%`;
    $('bar-warn-mark').style.left = `${warnPct}%`;
    $('bar-crit-mark').style.left = `${critPct}%`;
    $('bar-left-label').textContent = `${fmtTokens(used)} of ${fmtTokens(limit)} used`;
    $('bar-right-label').textContent = `Getting full ${warnPct}% · Almost full ${critPct}%`;

    // 4 Quick Stat Tiles (Plain English)
    const hitPct = Math.round(cur.cacheHitRate * 100);
    $('stat-cache').textContent = `${hitPct}%`;
    $('stat-cache-sub').textContent = hitPct >= 75
      ? 'most of memory was reused'
      : hitPct >= 30
        ? 'partly reused from earlier'
        : hitPct > 0
          ? 'mostly new this step'
          : 'all new on this step';

    const deltaEl = $('stat-delta');
    deltaEl.textContent = fmtDelta(cur.lastDeltaTokens);
    deltaEl.className = `stat-val ${cur.lastDeltaTokens < 0 ? 'neg' : cur.lastDeltaTokens > 12000 ? 'pos' : ''}`;
    $('stat-delta-sub').textContent = cur.lastDeltaTokens < 0
      ? 'freed by summary'
      : cur.lastDeltaTokens === 0
        ? 'no change'
        : 'added this step';

    const winPrompts = tot.windowPromptCount ?? tot.userMessageCount ?? 0;
    const winSteps = tot.currentWindowTurnCount ?? 0;
    const pWord = winPrompts === 1 ? 'prompt' : 'prompts';
    const sWord = winSteps === 1 ? 'step' : 'steps';
    $('stat-turns').innerHTML =
      `<span class="dual-num">${winPrompts}</span> <span class="dual-unit">${pWord}</span>` +
      ` <span class="dual-dot">·</span> ` +
      `<span class="dual-num">${winSteps}</span> <span class="dual-unit">${sWord}</span>`;
    $('stat-turns-sub').textContent = tot.compactionCount > 0
      ? `since cleanup · ${tot.userMessageCount} prompts, ${tot.turnCount} steps total`
      : 'you (human) · AI agent actions';

    $('stat-compactions').textContent = `${tot.compactionCount}`;
    const lastComp = d.compactions.length ? d.compactions[d.compactions.length - 1] : null;
    $('stat-compactions-sub').textContent = lastComp
      ? `last: ${fmtTokens(lastComp.beforeTokens)} → ${fmtTokens(lastComp.afterTokens)}`
      : 'none yet';

    // Memory Advisor Card
    renderAdvisor(d, p, used, pct, warnPct, critPct, hasEta, stepsLeft);

    // Category Breakdown
    renderCategories(d.categories);

    // Turn Growth Chart
    renderChart(d, limit, warnPct, critPct);

    // Heavy Turns
    renderHeavyTurns(d.heavyTurns);

    // Advanced Cumulative + Footer
    $('footer-cumulative').textContent =
      `All steps combined: ${fmtTokens(tot.cumulativeInputTokens)} new · ${fmtTokens(tot.cumulativeCacheReadTokens)} reused · ${fmtTokens(tot.cumulativeOutputTokens)} AI replies`;
    $('footer-updated').textContent = `v2.1 · Updated ${fmtTimeAgo(d.lastUpdatedAt)}`;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderAdvisor(d, payload, used, pct, warnPct, critPct, hasEta, stepsLeft) {
    const list = $('advisor-list');
    if (!list) return;
    list.innerHTML = '';

    const items = [];
    const cur = d.current || {};
    const tot = d.totals || {};

    const base = cur.firstTurnBaseTokens || 0;
    const userCat = (d.categories || []).find((c) => c.key === 'userPrompts');
    const userPct = userCat ? Math.round(userCat.pct) : 0;
    const apps = Array.isArray(d.toolCostByApp) ? d.toolCostByApp : [];
    const bigExternalApp = apps.find(
      (a) => (a.kind === 'mcp' || a.kind === 'appcmd') && used > 0 && a.tokens / used >= 0.35 && a.tokens >= 40_000,
    );

    let specificSuggestion = '';
    if (userCat && userPct >= 18 && userCat.tokens >= 20_000) {
      specificSuggestion =
        `Pasted text in your prompts is taking ${userPct}% of memory (${fmtTokens(userCat.tokens)}). Save long logs or scripts to a file and ask the AI to read the file instead.`;
    } else if (bigExternalApp) {
      specificSuggestion =
        `${bigExternalApp.app} added ${fmtTokens(bigExternalApp.tokens)}. Ask the AI to inspect named objects instead of full-scene dumps or repeated screenshots.`;
    } else if (base >= 24_000) {
      specificSuggestion =
        `Fixed setup starts at ${fmtTokens(base)} before your first message. Turning off app/MCP plugins you aren't using today will give new chats extra room.`;
    }

    const verdictEl = $('advisor-verdict');
    const vTitle = $('advisor-verdict-title');
    const vBody = $('advisor-verdict-body');
    const almostFull = pct >= critPct || (hasEta && stepsLeft <= 3);

    if (specificSuggestion) {
      verdictEl.className = `advisor-verdict ${almostFull ? 'crit' : 'warn'} has-tip`;
      vTitle.textContent = 'One small tweak can save memory:';
      vBody.textContent = almostFull
        ? `${specificSuggestion} Also type /compact soon since this chat is almost full.`
        : specificSuggestion;
    } else if (almostFull) {
      verdictEl.className = 'advisor-verdict crit has-tip';
      vTitle.textContent = "You didn't do anything wrong — it's just time to clear the desk.";
      vBody.textContent =
        'Your prompts are tiny; behind-the-scenes file reads and command outputs naturally add up over a long chat. Type /compact now to keep going here, or start a new chat for a fresh topic.';
    } else if (pct >= warnPct) {
      verdictEl.className = 'advisor-verdict warn has-tip';
      vTitle.textContent = 'Your habits look fine — this chat has just been busy.';
      vBody.textContent =
        "Don't shorten your prompts. Finish this task, then type /compact or open a fresh chat before starting the next big thing.";
    } else {
      verdictEl.className = 'advisor-verdict good has-tip';
      vTitle.textContent = "Don't worry about it — you're all good.";
      vBody.textContent =
        "No need to change how you're working. File reads and commands naturally use most of the workbench, and you still have plenty of space.";
    }

    // 1. Tool & App usage (server-attributed jumps)
    for (const item of apps.slice(0, 3)) {
      if (item.tokens < 300) continue;
      const pctOfUsed = used > 0 ? (item.tokens / used) * 100 : 0;
      const isBig = pctOfUsed >= 15 || item.biggestSingle >= 8000;
      const actWord = item.calls === 1 ? 'action' : 'actions';
      let lineHtml = '';
      let tipLine = '';
      let hoverBody = '';

      if (item.kind === 'mcp' || item.kind === 'appcmd') {
        lineHtml = `<strong>${escHtml(item.app)}</strong> used <strong>${fmtTokens(item.tokens)}</strong> this window (${item.calls} ${actWord}). Biggest single result: ${fmtTokens(item.biggestSingle)}.`;
        hoverBody = `Measured from memory jumps right after ${item.app} ran.`;
        if (isBig) {
          tipLine = 'Large scene dumps or screenshots stay in memory — ask for short summaries when you can.';
        }
      } else if (item.kind === 'read') {
        lineHtml = `<strong>Reading files</strong> used <strong>${fmtTokens(item.tokens)}</strong> (${item.calls} ${actWord}).`
          + (item.biggestSingle >= 4000 ? ` Biggest single read: ${fmtTokens(item.biggestSingle)}.` : '');
        hoverBody = 'Measured from memory jumps right after the AI read files.';
        if (isBig) {
          tipLine = 'Ask for specific parts of big files instead of whole files.';
        }
      } else if (item.kind === 'cmd' || item.kind === 'task') {
        lineHtml = `<strong>Running commands</strong> used <strong>${fmtTokens(item.tokens)}</strong> (${item.calls} ${actWord}).`
          + (item.biggestSingle >= 4000 ? ` Biggest single output: ${fmtTokens(item.biggestSingle)}.` : '');
        hoverBody = 'Measured from memory jumps right after terminal commands ran.';
        if (isBig) {
          tipLine = 'Long terminal logs fill memory quickly — quieter output keeps chats lighter.';
        }
      } else {
        lineHtml = `<strong>${escHtml(item.app)}</strong> used <strong>${fmtTokens(item.tokens)}</strong> (${item.calls} ${actWord}).`;
        hoverBody = 'Measured from memory jumps after these actions.';
        if (item.biggestSingle >= 8000) {
          tipLine = `Biggest single jump added ${fmtTokens(item.biggestSingle)}.`;
        }
      }

      items.push({
        weight: item.tokens,
        kindClass: item.kind === 'mcp' || item.kind === 'appcmd' ? 'app' : 'tool',
        html: lineHtml,
        tipLine,
        tipTitle: item.app,
        tipBody: hoverBody,
      });
    }

    // 2. Fixed setup (Turn-1 base + session comparison + optional read-only AGENTS.md size)
    if (base > 0) {
      const recentBases = (state.sessions || [])
        .map((s) => s.baseTokens || 0)
        .filter((v) => v > 0)
        .slice(0, 4);
      let fixedHtml = `<strong>Fixed setup</strong> costs about <strong>${fmtTokens(base)}</strong> on every step (rules, skills, tool list).`;
      if (payload?.agentsMd?.found && payload.agentsMd.tokensEst > 0) {
        fixedHtml += ` AGENTS.md is about ${fmtTokens(payload.agentsMd.tokensEst)} (estimated from file size).`;
      }
      if (recentBases.length >= 2) {
        fixedHtml += ` Fixed setup in your last chats: ${recentBases.map((v) => fmtTokens(v)).join(' · ')}.`;
      }
      const fixedBig = base >= 22_000 || (used > 0 && base / used >= 0.35);
      items.push({
        weight: base,
        kindClass: 'base',
        html: fixedHtml,
        tipLine: fixedBig ? "Turning off tool servers you don't need in this chat makes new chats start smaller." : '',
        tipTitle: 'Fixed Setup',
        tipBody: 'Built-in rules, skills, and connected tool definitions loaded at the start of every chat. Compare new chats after toggling a tool server to see what it costs.',
      });
    }

    // 3. Your prompts
    if (userCat && tot.userMessageCount > 0) {
      if (userPct <= 5) {
        items.push({
          weight: userCat.tokens,
          kindClass: 'user',
          html: `<strong>Your prompts</strong> are only <strong>${Math.max(1, userPct)}%</strong> (${fmtTokens(userCat.tokens)}). Don't shorten them — they're not the problem.`,
          tipLine: '',
          tipTitle: 'Your Prompts',
          tipBody: 'Your typed prompts take up very little space compared to tool results and fixed setup.',
        });
      } else if (userPct >= 15) {
        items.push({
          weight: userCat.tokens,
          kindClass: 'user',
          html: `<strong>Your prompts</strong> are <strong>${userPct}%</strong> (${fmtTokens(userCat.tokens)}).`,
          tipLine: 'Long pasted logs or text stay in memory for the rest of the chat — linking files instead keeps things lighter.',
          tipTitle: 'Your Prompts',
          tipBody: 'Share of memory used by prompts and text you typed or pasted.',
        });
      }
    }

    // 4. Post-cleanup summary note
    if (Array.isArray(d.compactions) && d.compactions.length > 0) {
      const lastC = d.compactions[d.compactions.length - 1];
      items.push({
        weight: 100, // Keep below main byte drivers unless few items exist
        kindClass: 'summary',
        html: `<strong>Memory was summarized</strong> at <strong>${fmtTokens(lastC.beforeTokens)}</strong> (${fmtTokens(lastC.afterTokens)} after). Start a fresh chat for a new task to keep details sharp.`,
        tipLine: '',
        tipTitle: 'Summary Reset',
        tipBody: 'Once a chat summarizes older turns, exact details from early steps are condensed.',
      });
    }

    // Sort biggest first and keep top 3-5 plain lines
    items.sort((a, b) => b.weight - a.weight);
    const chosen = items.slice(0, 5);
    if (!chosen.length) {
      list.innerHTML = '<div class="empty-inline">Waiting for more steps to analyze…</div>';
      return;
    }

    for (const it of chosen) {
      const row = document.createElement('div');
      row.className = `advisor-item kind-${it.kindClass} has-tip`;
      row.tabIndex = 0;
      row.dataset.tipTitle = it.tipTitle;
      row.dataset.tipBody = it.tipBody;
      row.innerHTML =
        `<div class="advisor-main">${it.html}</div>` +
        (it.tipLine ? `<div class="advisor-tip">${escHtml(it.tipLine)}</div>` : '');
      list.appendChild(row);
    }
  }

  const CAT_HELP = {
    systemBase: {
      title: 'Fixed setup',
      body: 'Rules, skills, connected tool list, plus the summary after a cleanup. Loaded automatically on every step.',
    },
    toolOutputs: {
      title: 'Tool results',
      body: 'Files the AI read, commands it ran, and app tools it used. Usually the #1 thing that fills up memory.',
    },
    assistantAndThinking: {
      title: "AI's replies and thinking",
      body: "The AI's written answers plus its behind-the-scenes thinking.",
    },
    userPrompts: {
      title: 'Your prompts',
      body: 'The prompts, questions, and pasted text you sent into this chat.',
    },
    systemNotices: {
      title: 'System notes',
      body: 'Internal system reminders, error notices, and cleanup summary markers.',
    },
  };

  function renderCategories(categories) {
    const bar = $('cat-bar');
    const list = $('cat-list');
    bar.innerHTML = '';
    list.innerHTML = '';

    for (const c of categories) {
      const help = CAT_HELP[c.key] || { title: c.label, body: 'Part of active memory.' };
      if (c.tokens > 0) {
        const seg = document.createElement('div');
        seg.className = 'cat-seg has-tip';
        seg.style.width = `${Math.max(1, c.pct).toFixed(2)}%`;
        seg.style.background = c.colorVar;
        seg.dataset.tipTitle = `${help.title} (${c.pct.toFixed(1)}%)`;
        seg.dataset.tipBody = `Using ${fmtTokens(c.tokens)}. ${help.body}`;
        bar.appendChild(seg);
      }

      const row = document.createElement('div');
      row.className = 'cat-row has-tip';
      row.tabIndex = 0;
      row.dataset.tipTitle = `${help.title} — ${fmtTokens(c.tokens)}`;
      row.dataset.tipBody = help.body;
      row.innerHTML = `
        <span class="cat-swatch" style="background:${c.colorVar}"></span>
        <span class="cat-name tip-cue"></span>
        <span class="cat-tokens">${fmtTokens(c.tokens)}</span>
        <span class="cat-pct">${fmtGaugePct(c.pct)}</span>
      `;
      row.querySelector('.cat-name').textContent = c.label;
      list.appendChild(row);
    }
  }

  function renderChart(d, limit, warnPct, critPct) {
    const svg = $('growth-svg');
    const tooltip = $('chart-tooltip');
    tooltip.classList.add('hidden');

    const turns = prefs.chartScope === 'window'
      ? d.turns.slice(d.epochStartTurn)
      : d.turns;

    const wrap = $('chart-wrap');
    const W = Math.max(260, Math.round(wrap?.clientWidth || svg.clientWidth || 360));
    const H = Math.max(124, Math.round(wrap?.clientHeight || 136));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pad = { top: 14, right: 12, bottom: 20, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    if (!turns.length) {
      svg.innerHTML = '';
      return;
    }

    const chartSub = $('chart-sub');
    if (chartSub) {
      const winPrompts = d.totals.windowPromptCount ?? d.totals.userMessageCount ?? 0;
      const winPromptWord = winPrompts === 1 ? 'prompt' : 'prompts';
      const allPromptWord = d.totals.userMessageCount === 1 ? 'prompt' : 'prompts';
      if (prefs.chartScope === 'window' && d.epochStartTurn > 0) {
        chartSub.textContent = `Since cleanup: ${winPrompts} ${winPromptWord} from you → AI steps ${turns[0].turn}–${turns[turns.length - 1].turn} (green dot = your prompt)`;
      } else {
        chartSub.textContent = `You sent ${d.totals.userMessageCount} ${allPromptWord} → agent took ${d.totals.turnCount} AI steps (green = your prompt, blue = AI step)`;
      }
    }

    const peakTurn = Math.max(...turns.map((t) => t.contextTokens), 1);
    const warnYVal = (limit * warnPct) / 100;
    const critYVal = (limit * critPct) / 100;
    // Scale Y axis nicely so both data and thresholds read cleanly without squashing small sessions.
    const yMax = Math.max(peakTurn * 1.18, limit * 0.25, peakTurn > warnYVal * 0.5 ? limit : peakTurn * 1.3);

    const xOf = (idx) => (turns.length === 1 ? pad.left + plotW / 2 : pad.left + (idx / (turns.length - 1)) * plotW);
    const yOf = (val) => pad.top + plotH - clamp(val / yMax, 0, 1) * plotH;

    const pts = turns.map((t, i) => ({ x: xOf(i), y: yOf(t.contextTokens), t }));

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const areaPath =
      `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} ` +
      `L ${pts[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;

    const yTicks = [0, yMax * 0.5, yMax];
    let markup = `
      <defs>
        <linearGradient id="cmAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--cm-cache)" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="var(--cm-cache)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
    `;

    // Grid lines + Y labels
    for (const val of yTicks) {
      const y = yOf(val).toFixed(1);
      markup += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="var(--cm-border)" stroke-width="1"/>`;
      markup += `<text x="${pad.left - 5}" y="${Number(y) + 3}" text-anchor="end" fill="var(--cm-muted)" font-size="9.5" font-family="var(--cm-mono)">${fmtTokens(val)}</text>`;
    }

    // Warn / Crit guide lines if within Y axis range
    if (warnYVal <= yMax) {
      const wy = yOf(warnYVal).toFixed(1);
      markup += `<line x1="${pad.left}" y1="${wy}" x2="${W - pad.right}" y2="${wy}" stroke="var(--cm-warn)" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>`;
    }
    if (critYVal <= yMax) {
      const cy = yOf(critYVal).toFixed(1);
      markup += `<line x1="${pad.left}" y1="${cy}" x2="${W - pad.right}" y2="${cy}" stroke="var(--cm-crit)" stroke-width="1" stroke-dasharray="4 3" opacity="0.85"/>`;
    }

    // Compaction markers
    for (const p of pts) {
      if (p.t.compacted) {
        markup += `<line x1="${p.x.toFixed(1)}" y1="${pad.top}" x2="${p.x.toFixed(1)}" y2="${pad.top + plotH}" stroke="var(--cm-out)" stroke-width="1.2" stroke-dasharray="2 2"/>`;
      }
    }

    // Area + Line
    const chartAnimKey = `${d.conversationId || targetConv()}:${prefs.chartScope}`;
    const shouldRevealLine = state.lastChartAnimKey !== chartAnimKey;
    state.lastChartAnimKey = chartAnimKey;
    if (pts.length > 1) {
      markup += `<path d="${areaPath}" fill="url(#cmAreaGrad)"/>`;
      markup += `<path class="${shouldRevealLine ? 'chart-line-reveal' : ''}" d="${linePath}" fill="none" stroke="var(--cm-cache)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    // Step dots: green = your prompt, purple = summary reset, blue = AI step + live pulse on newest point
    const showAllDots = pts.length <= 24;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const isLast = i === pts.length - 1;
      const isPrompt = Boolean(p.t.isPromptStart);
      if (isLast) {
        markup += `<circle class="chart-live-ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"/>`;
      }
      if (isPrompt) {
        const ring = p.t.compacted ? 'var(--cm-out)' : 'var(--cm-card)';
        markup += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isLast ? 4 : 3.4}" fill="var(--cm-cat-user)" stroke="${ring}" stroke-width="1.3"/>`;
      } else if (showAllDots || isLast || p.t.compacted) {
        const fill = p.t.compacted ? 'var(--cm-out)' : 'var(--cm-cache)';
        const r = isLast ? 3.5 : 2.3;
        markup += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}"/>`;
      }
    }

    // X-axis start/end labels
    const firstTurnNum = turns[0].turn;
    const lastTurnNum = turns[turns.length - 1].turn;
    const startLabel = prefs.chartScope === 'window' && d.epochStartTurn > 0
      ? `Step ${firstTurnNum} (after cleanup)`
      : `Step ${firstTurnNum}`;
    markup += `<text x="${pad.left}" y="${H - 4}" fill="var(--cm-muted)" font-size="9.5" font-family="var(--cm-mono)">${startLabel}</text>`;
    if (lastTurnNum !== firstTurnNum) {
      markup += `<text x="${W - pad.right}" y="${H - 4}" text-anchor="end" fill="var(--cm-muted)" font-size="9.5" font-family="var(--cm-mono)">Step ${lastTurnNum}</text>`;
    }

    // Hover crosshair group
    markup += `<line id="cm-hover-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}" stroke="var(--cm-fg)" stroke-opacity="0.3" stroke-width="1" visibility="hidden"/>`;
    markup += `<circle id="cm-hover-dot" cx="0" cy="0" r="4" fill="var(--cm-cache)" stroke="var(--cm-card)" stroke-width="1.5" visibility="hidden"/>`;

    svg.innerHTML = markup;

    const hoverLine = svg.querySelector('#cm-hover-line');
    const hoverDot = svg.querySelector('#cm-hover-dot');

    const showChartStepTooltip = (nearest) => {
      if (!nearest) return;
      hoverLine.setAttribute('x1', nearest.x.toFixed(1));
      hoverLine.setAttribute('x2', nearest.x.toFixed(1));
      hoverLine.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', nearest.x.toFixed(1));
      hoverDot.setAttribute('cy', nearest.y.toFixed(1));
      hoverDot.setAttribute('visibility', 'visible');

      const t = nearest.t;
      const hit = Math.round(t.cacheHitRate * 100);
      const act = t.triggerLabel ? `<br><span class="chart-tip-act">AI did: ${escHtml(t.triggerLabel)}</span>` : '';
      const userLine = (t.promptNumber > 0 || t.promptSnippet)
        ? `<span class="chart-tip-user">${t.isPromptStart ? '● ' : ''}Prompt #${t.promptNumber || 1}${t.promptSnippet ? `: “${escHtml(t.promptSnippet)}”` : ''}</span>`
        : '';
      tooltip.innerHTML =
        `<strong>AI Step ${t.turn}</strong> · <strong>${fmtTokens(t.contextTokens)}</strong> (${fmtDelta(t.deltaTokens)}) · Reused ${hit}%${t.compacted ? ' · Summarized' : ''}${act}${userLine}`;
      tooltip.classList.remove('hidden');
    };

    const clearChartStepTooltip = () => {
      hoverLine.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tooltip.classList.add('hidden');
    };

    state.highlightChartTurn = (turnNum, shouldScroll = false) => {
      const target = pts.find((p) => p.t.turn === turnNum);
      if (!target) return;
      if (shouldScroll) {
        $('chart-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      showChartStepTooltip(target);
    };
    state.clearChartHighlight = clearChartStepTooltip;

    svg.onpointermove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * W;
      let nearest = pts[0];
      let bestDist = Infinity;
      for (const p of pts) {
        const dist = Math.abs(p.x - relX);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = p;
        }
      }
      showChartStepTooltip(nearest);
    };

    svg.onpointerleave = clearChartStepTooltip;
  }

  function renderHeavyTurns(heavyTurns) {
    const list = $('heavy-list');
    list.innerHTML = '';
    if (!heavyTurns || !heavyTurns.length) {
      list.innerHTML = '<div class="empty-inline">No big memory jumps yet.</div>';
      return;
    }

    const maxDelta = Math.max(...heavyTurns.map((h) => h.deltaTokens), 1);
    for (const h of heavyTurns) {
      const item = document.createElement('div');
      item.className = 'heavy-item has-tip';
      item.tabIndex = 0;
      const barPct = clamp((h.deltaTokens / maxDelta) * 100, 6, 100);
      const isPromptStep = /^Your (?:first )?prompt:/i.test(h.triggerLabel || '');
      const pNum = h.promptNumber || 1;
      const pSnip = h.promptSnippet || '';
      const promptTitlePart = pNum ? ` · From Prompt #${pNum}` : '';
      const promptBodyPart = isPromptStep
        ? ''
        : pSnip
          ? ` Caused by your Prompt #${pNum}: "${pSnip}".`
          : pNum
            ? ` Triggered during Prompt #${pNum}.`
            : '';
      item.dataset.tipTitle = `AI Step ${h.turn} (+${fmtTokens(h.deltaTokens)})${promptTitlePart}`;
      item.dataset.tipBody =
        `AI did: ${h.triggerLabel || 'AI step'}.${promptBodyPart} Total memory reached ${fmtTokens(h.contextTokens)}. Hover or click to spotlight Step ${h.turn} on the chart.`;

      const promptRowHtml = !isPromptStep && (pNum || pSnip)
        ? `<div class="heavy-prompt-row"><span class="heavy-prompt-badge">Prompt #${pNum}</span><span class="heavy-prompt-text"></span></div>`
        : '';
      item.innerHTML = `
        <div class="heavy-row">
          <span class="heavy-label"></span>
          <span class="heavy-delta">+${fmtTokens(h.deltaTokens)}</span>
        </div>
        ${promptRowHtml}
        <div class="heavy-meta">
          <span>AI Step ${h.turn}</span>
          <div class="heavy-bar-track"><div class="heavy-bar-fill" style="width:${barPct.toFixed(1)}%"></div></div>
        </div>
      `;
      const lbl = item.querySelector('.heavy-label');
      lbl.textContent = h.triggerLabel || `AI Step ${h.turn}`;
      const pText = item.querySelector('.heavy-prompt-text');
      if (pText) {
        pText.textContent = pSnip ? `You asked: “${pSnip}”` : 'From your prompt';
      }
      item.addEventListener('mouseenter', () => state.highlightChartTurn?.(h.turn, false));
      item.addEventListener('mouseleave', () => state.clearChartHighlight?.());
      item.addEventListener('click', () => state.highlightChartTurn?.(h.turn, true));
      list.appendChild(item);
    }
  }

  function renderSessionSelect() {
    const sel = $('session-select');
    const active = resolveHostConv();
    const followBtn = $('btn-follow');

    followBtn.classList.toggle('hidden', !state.pinnedConv || state.pinnedConv === active);

    const options = [];
    if (active) {
      const rawActive =
        state.payload && state.payload.conversationId === active && state.payload.title
          ? state.payload.title
          : `Active (${active.slice(0, 8)})`;
      const activeTitle = cleanChatTitle(rawActive) || `Active (${active.slice(0, 8)})`;
      options.push({ value: '', label: `● ${activeTitle}` });
    } else {
      options.push({ value: '', label: 'Following open chat…' });
    }

    for (const s of state.sessions) {
      if (s.conversationId === active) continue;
      const clean = cleanChatTitle(s.title) || `Chat ${s.conversationId.slice(0, 8)}`;
      options.push({
        value: s.conversationId,
        label: clean,
      });
    }

    const sig = options.map((o) => `${o.value}|${o.label}`).join('\n');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = '';
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
    }
    sel.value = state.pinnedConv || '';
  }

  // ---------- Polling ----------
  async function poll(forceBust = false) {
    const hostConv = resolveHostConv();
    if (hostConv !== state.activeConv) {
      state.activeConv = hostConv;
      if (!state.pinnedConv) {
        state.etag = '';
      }
    }

    const conv = targetConv();
    const livePill = $('live-pill');

    try {
      const now = Date.now();
      if (forceBust || now - state.lastSessionsAt > SESSIONS_POLL_MS) {
        state.lastSessionsAt = now;
        const sRes = await getJson(forceBust ? `/api/sessions?_t=${now}` : '/api/sessions');
        if (Array.isArray(sRes?.sessions)) {
          state.sessions = sRes.sessions;
        }
      }

      if (conv) {
        const qs = new URLSearchParams({ conversationId: conv });
        if (state.workspaceUri) qs.set('workspaceUri', state.workspaceUri);
        if (state.etag) qs.set('etag', state.etag);
        if (forceBust) qs.set('_t', String(Date.now()));
        const res = await getJson(`/api/context?${qs.toString()}`);
        if (res.uiVersion) {
          if (!state.uiVersion) {
            state.uiVersion = res.uiVersion;
          } else if (state.uiVersion !== res.uiVersion) {
            location.reload();
            return;
          }
        }
        state.lastOkAt = Date.now();
        livePill.classList.remove('stale');
        $('live-label').textContent = state.pinnedConv ? 'Pinned' : 'Live';

        if (!res.unchanged) {
          state.etag = res.etag || '';
          state.payload = res;
          render();
        }
      } else {
        render();
      }
      renderSessionSelect();
    } catch {
      livePill.classList.add('stale');
      $('live-label').textContent = 'Reconnecting';
    }

    const delay = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(poll, delay);
  }

  // ---------- Controls & Events ----------
  $('input-warn').value = prefs.warnPct;
  $('input-crit').value = prefs.critPct;

  function syncScopeButtons() {
    $('scope-window').classList.toggle('active', prefs.chartScope === 'window');
    $('scope-all').classList.toggle('active', prefs.chartScope === 'all');
  }
  syncScopeButtons();

  function syncTipsState() {
    document.documentElement.dataset.tips = prefs.showTips ? 'on' : 'off';
    const btn = $('btn-tips');
    const lbl = $('tips-label');
    if (btn) {
      btn.classList.toggle('on', prefs.showTips);
      btn.setAttribute('aria-pressed', String(prefs.showTips));
    }
    if (lbl) lbl.textContent = prefs.showTips ? 'Tips: On' : 'Tips: Off';
    if (!prefs.showTips) hideTip();
  }
  syncTipsState();

  $('btn-tips')?.addEventListener('click', () => {
    prefs.showTips = !prefs.showTips;
    savePrefs();
    syncTipsState();
  });

  function syncGuideVisibility() {
    $('guide-card').classList.toggle('hidden', !prefs.showGuide);
    $('btn-guide').setAttribute('aria-expanded', String(prefs.showGuide));
  }
  syncGuideVisibility();

  function syncAdvancedVisibility() {
    $('advanced-body').classList.toggle('hidden', !prefs.showAdvanced);
    $('advanced-arrow').textContent = prefs.showAdvanced ? '▾' : '▸';
    $('btn-advanced').setAttribute('aria-expanded', String(prefs.showAdvanced));
  }
  syncAdvancedVisibility();

  $('btn-advanced').addEventListener('click', () => {
    prefs.showAdvanced = !prefs.showAdvanced;
    savePrefs();
    syncAdvancedVisibility();
  });

  $('btn-guide').addEventListener('click', () => {
    prefs.showGuide = !prefs.showGuide;
    savePrefs();
    syncGuideVisibility();
  });

  $('btn-hide-guide').addEventListener('click', () => {
    prefs.showGuide = false;
    savePrefs();
    syncGuideVisibility();
  });

  let refreshResetTimer = null;
  $('btn-refresh').addEventListener('click', async (e) => {
    const btn = $('btn-refresh');
    const lbl = $('refresh-label');
    const livePill = $('live-pill');
    const liveLabel = $('live-label');
    const heroCard = document.querySelector('.hero-card');

    // Shift-click forces a full iframe reload.
    if (e.shiftKey) {
      location.reload();
      return;
    }

    clearTimeout(refreshResetTimer);
    btn.classList.remove('spinning', 'refreshed');
    void btn.offsetWidth; // restart spin animation cleanly
    btn.classList.add('spinning');
    lbl.textContent = 'Refreshing…';
    livePill.classList.remove('stale', 'refreshed');
    liveLabel.textContent = 'Refreshing…';

    state.etag = '';
    state.lastSessionsAt = 0;
    clearTimeout(state.pollTimer);
    await poll(true);

    if (heroCard) {
      heroCard.classList.remove('flash-refresh');
      void heroCard.offsetWidth;
      heroCard.classList.add('flash-refresh');
    }

    btn.classList.add('refreshed');
    lbl.textContent = '✓ Refreshed';
    livePill.classList.add('refreshed');
    liveLabel.textContent = 'Refreshed!';
    const nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    $('footer-updated').textContent = `v2.1 · Refreshed ${nowStr}`;
    triggerChatSyncFlash('✓ Refreshed');

    refreshResetTimer = setTimeout(() => {
      btn.classList.remove('spinning', 'refreshed');
      lbl.textContent = 'Refresh';
      livePill.classList.remove('refreshed');
      liveLabel.textContent = state.pinnedConv ? 'Pinned' : 'Live';
    }, 2200);
  });

  $('btn-settings').addEventListener('click', () => {
    const drawer = $('settings-drawer');
    const open = drawer.classList.toggle('hidden') === false;
    $('btn-settings').setAttribute('aria-expanded', String(open));
  });

  // ---------- Plain-English Hover Popover Engine (Instant, Zero-Timer) ----------
  const tipEl = $('cm-tip');
  const tipTitleEl = $('cm-tip-title');
  const tipBodyEl = $('cm-tip-body');
  let tipTarget = null;

  function positionTip(anchor) {
    const rect = anchor.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    const tipW = tipEl.offsetWidth || 260;
    const tipH = tipEl.offsetHeight || 64;

    let left = rect.left + rect.width / 2 - tipW / 2;
    left = clamp(left, pad, Math.max(pad, vw - tipW - pad));

    let top = rect.top - tipH - 8;
    if (top < pad) {
      top = rect.bottom + 8;
    }
    if (top + tipH > vh - pad) {
      top = Math.max(pad, vh - tipH - pad);
    }
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
  }

  function showTip(el) {
    if (!prefs.showTips || !tipEl || !el) return;
    const title = el.getAttribute('data-tip-title') || '';
    const body = el.getAttribute('data-tip-body') || '';
    if (!title && !body) {
      hideTip();
      return;
    }
    if (tipTarget !== el || tipTitleEl.textContent !== title || tipBodyEl.textContent !== body) {
      tipTarget = el;
      tipTitleEl.textContent = title;
      tipBodyEl.textContent = body;
    }
    tipEl.style.display = 'block';
    positionTip(el);
  }

  function hideTip() {
    if (!tipEl) return;
    tipTarget = null;
    tipEl.style.display = 'none';
  }

  function findTipEl(node) {
    let cur = node;
    while (cur && cur !== document) {
      if (cur.nodeType === 1 && cur.classList && cur.classList.contains('has-tip')) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  function onPointerInspect(e) {
    const el = findTipEl(e.target);
    if (el) {
      showTip(el);
    } else if (tipTarget) {
      hideTip();
    }
  }

  document.addEventListener('mousemove', onPointerInspect, true);
  document.addEventListener('pointermove', onPointerInspect, true);
  document.addEventListener('mouseover', onPointerInspect, true);

  document.addEventListener('click', (e) => {
    const el = findTipEl(e.target);
    if (el && el.tagName !== 'BUTTON' && el.tagName !== 'SELECT' && el.tagName !== 'INPUT') {
      showTip(el);
    }
  });

  document.addEventListener('mouseleave', hideTip);
  document.addEventListener('focusin', (e) => {
    const el = findTipEl(e.target);
    if (el) showTip(el);
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

  $('input-warn').addEventListener('change', (e) => {
    prefs.warnPct = clamp(Number(e.target.value) || 60, 20, 90);
    if (prefs.critPct <= prefs.warnPct) {
      prefs.critPct = clamp(prefs.warnPct + 10, 30, 98);
      $('input-crit').value = prefs.critPct;
    }
    e.target.value = prefs.warnPct;
    savePrefs();
    render();
  });

  $('input-crit').addEventListener('change', (e) => {
    prefs.critPct = clamp(Number(e.target.value) || 80, prefs.warnPct + 5, 98);
    e.target.value = prefs.critPct;
    savePrefs();
    render();
  });

  $('btn-reset-settings').addEventListener('click', () => {
    prefs = { ...defaultPrefs };
    $('input-warn').value = prefs.warnPct;
    $('input-crit').value = prefs.critPct;
    syncScopeButtons();
    syncGuideVisibility();
    syncAdvancedVisibility();
    syncTipsState();
    savePrefs();
    render();
  });

  $('session-select').addEventListener('change', (e) => {
    state.pinnedConv = e.target.value || null;
    state.etag = '';
    poll();
  });

  $('btn-follow').addEventListener('click', () => {
    state.pinnedConv = null;
    state.etag = '';
    poll();
  });

  $('scope-window').addEventListener('click', () => {
    prefs.chartScope = 'window';
    syncScopeButtons();
    savePrefs();
    render();
  });

  $('scope-all').addEventListener('click', () => {
    prefs.chartScope = 'all';
    syncScopeButtons();
    savePrefs();
    render();
  });

  $('btn-copy-compact').addEventListener('click', async () => {
    const btn = $('btn-copy-compact');
    try {
      await navigator.clipboard.writeText('/compact');
      btn.textContent = 'Copied /compact';
      setTimeout(() => {
        btn.innerHTML = 'Copy <code>/compact</code>';
      }, 1800);
    } catch {
      btn.textContent = 'Type /compact in chat';
      setTimeout(() => {
        btn.innerHTML = 'Copy <code>/compact</code>';
      }, 2200);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.hiddenAt = Date.now();
      return;
    }
    const awayMs = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
    state.hiddenAt = 0;
    if (awayMs > 400) triggerChatSyncFlash('✓ Back in view');
    clearTimeout(state.pollTimer);
    poll();
  });

  window.addEventListener('focus', () => {
    triggerChatSyncFlash('✓ Linked');
    clearTimeout(state.pollTimer);
    poll();
  });

  if (typeof ResizeObserver === 'function' && $('chart-wrap')) {
    let lastChartW = 0;
    let resizeRaf = 0;
    const chartRo = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (Math.abs(w - lastChartW) < 2) return;
      lastChartW = w;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (state.payload?.data?.hasData) render();
      });
    });
    chartRo.observe($('chart-wrap'));
  }

  poll();
})();
