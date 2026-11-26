/**
 * Pure read-only parser for Antigravity transcript.jsonl files.
 * Extracts exact server-reported token telemetry, cache hit rates,
 * auto-compaction events, reconciled category breakdowns, and heavy turns.
 */

const MODEL_SPECS = [
  // Note: gemini-pro-orchestrator compacted manually at 273.9K without auto-compacting yet; keep 256K default and let learned ceiling adjust when beforeTokens exceeds it.
  { match: /gemini-4-neon/i, label: 'Gemini 4 Neon', limit: 512_000, windowLabel: '512K' },
  { match: /gemini-4-hydrogen-high/i, label: 'Gemini 4 Hydrogen', limit: 512_000, windowLabel: '512K' },
  { match: /gemini-4-hydrogen/i, label: 'Gemini 4 Hydrogen', limit: 256_000, windowLabel: '256K' },
  { match: /gemini-4-argon/i, label: 'Gemini 4 Argon', limit: 256_000, windowLabel: '256K' },
  { match: /gemini-4/i, label: 'Gemini 4', limit: 512_000, windowLabel: '512K' },
  { match: /gemini-3|gemini-2\.5|gemini-2/i, label: 'Gemini', limit: 1_000_000, windowLabel: '1M' },
  { match: /claude-.*(opus|sonnet)-4/i, label: 'Claude', limit: 200_000, windowLabel: '200K' },
  { match: /claude/i, label: 'Claude', limit: 200_000, windowLabel: '200K' },
  { match: /gpt-5|gpt-4|o3|o4/i, label: 'OpenAI', limit: 256_000, windowLabel: '256K' },
];

export function formatModelName(rawModel) {
  if (!rawModel || typeof rawModel !== 'string') return 'Model not reported yet';
  const clean = rawModel.trim();
  if (!clean || clean.toLowerCase() === 'unknown') return 'Model not reported yet';
  // Map internal slugs like "gemini-4-neon-high" -> "Gemini 4 Neon (High)"
  const effortMatch = clean.match(/^(.*?)-(low|medium|high|max|fast|lite)$/i);
  const base = effortMatch ? effortMatch[1] : clean;
  const effort = effortMatch ? effortMatch[2] : '';

  const niceBase = base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (part.toLowerCase() === 'gpt') return 'GPT';
      if (part.toLowerCase() === 'agy') return 'AGY';
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');

  if (effort) {
    const niceEffort = effort.charAt(0).toUpperCase() + effort.slice(1).toLowerCase();
    return `${niceBase} (${niceEffort})`;
  }
  return niceBase || clean;
}

export function inferModelSpec(rawModel) {
  const m = typeof rawModel === 'string' ? rawModel : '';
  for (const spec of MODEL_SPECS) {
    if (spec.match.test(m)) {
      return {
        raw: m,
        displayName: formatModelName(m),
        contextLimit: spec.limit,
        windowLabel: spec.windowLabel,
      };
    }
  }
  return {
    raw: m,
    displayName: formatModelName(m),
    contextLimit: 256_000,
    windowLabel: '256K',
  };
}

function estimateCharsTokens(str) {
  if (!str || typeof str !== 'string') return 0;
  return Math.ceil(str.length / 4);
}

export function cleanChatTitle(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/@\[conversation:"([^"]+)"\]/gi, '$1')
    .replace(/@\[[^\]:]+:"?([^"\]]+)"?\]/g, '$1')
    .replace(/@\[([^\]]+)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUserSnippet(content) {
  if (!content || typeof content !== 'string') return '';
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = cleanChatTitle(m ? m[1] : content);
  return body.length > 90 ? body.slice(0, 89) + '…' : body;
}

function unquoteArg(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

const NICE_APP_NAMES = {
  blender: 'Blender',
  maya: 'Maya',
  nuke: 'Nuke',
  photoshop: 'Photoshop',
  spline: 'Spline',
  figma: 'Figma',
  canva: 'Canva',
  houdini: 'Houdini',
  unreal: 'Unreal',
  unity: 'Unity',
  cinema4d: 'Cinema 4D',
  zbrush: 'ZBrush',
  substance: 'Substance',
  inkscape: 'Inkscape',
  tldraw: 'tldraw',
  gdrive: 'Google Drive',
  gdocs: 'Google Docs',
};

function formatAppName(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'App';
  if (NICE_APP_NAMES[key]) return NICE_APP_NAMES[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function classifyToolCall(tc) {
  const name = (tc?.name || '').trim();
  const args = tc?.args || tc?.arguments || {};

  if (name === 'call_mcp_tool') {
    const srv = unquoteArg(String(args.ServerName || '')).trim().toLowerCase() || 'mcp';
    const appShort = formatAppName(srv);
    return { groupKey: `mcp:${srv}`, appLabel: `${appShort} tools`, appShort, kind: 'mcp' };
  }

  const directMcp = name.match(
    /^(?:mcp_)?(blender|maya|nuke|photoshop|spline|figma|canva|houdini|unreal|unity|cinema4d|zbrush|substance|inkscape|tldraw|gdrive|gdocs)[_-]/i,
  );
  if (directMcp) {
    const key = directMcp[1].toLowerCase();
    const appShort = formatAppName(key);
    return { groupKey: `mcp:${key}`, appLabel: `${appShort} tools`, appShort, kind: 'mcp' };
  }

  if (name === 'run_command') {
    const cmd = String(args.CommandLine || args.command || '');
    if (!/\.gemini[\\/]+antigravity[\\/]+brain/i.test(cmd)) {
      if (/\bmayapy(?:\.exe)?\b|\brun_maya\.py\b|\bmaya\.standalone\b|127\.0\.0\.1:7001/i.test(cmd)) {
        return { groupKey: 'appcmd:maya', appLabel: 'Maya commands', appShort: 'Maya', kind: 'appcmd' };
      }
      if (/\bblender(?:\.exe)?\b|\bimport\s+bpy\b/i.test(cmd)) {
        return { groupKey: 'appcmd:blender', appLabel: 'Blender commands', appShort: 'Blender', kind: 'appcmd' };
      }
      if (/\bnuke\d*(?:\.exe)?\b/i.test(cmd)) {
        return { groupKey: 'appcmd:nuke', appLabel: 'Nuke commands', appShort: 'Nuke', kind: 'appcmd' };
      }
      if (/Photoshop\.Application|\bphotoshop(?:\.exe)?\b/i.test(cmd)) {
        return { groupKey: 'appcmd:photoshop', appLabel: 'Photoshop commands', appShort: 'Photoshop', kind: 'appcmd' };
      }
      if (/\binkscape(?:\.exe)?\b/i.test(cmd)) {
        return { groupKey: 'appcmd:inkscape', appLabel: 'Inkscape commands', appShort: 'Inkscape', kind: 'appcmd' };
      }
    }
    return { groupKey: 'builtin:cmd', appLabel: 'Running commands', kind: 'cmd' };
  }

  if (['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'read_url_content'].includes(name)) {
    return { groupKey: 'builtin:read', appLabel: 'Reading files', kind: 'read' };
  }
  if (['edit_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) {
    return { groupKey: 'builtin:edit', appLabel: 'Editing files', kind: 'edit' };
  }
  if (['write_file', 'write_to_file'].includes(name)) {
    return { groupKey: 'builtin:write', appLabel: 'Editing files', kind: 'write' };
  }
  if (['grep_search', 'find_by_name'].includes(name)) {
    return { groupKey: 'builtin:search', appLabel: 'Searching', kind: 'search' };
  }
  if (name === 'list_dir') {
    return { groupKey: 'builtin:list', appLabel: 'Searching', kind: 'list' };
  }
  if (['search_web', 'search_marketplace'].includes(name)) {
    return { groupKey: 'builtin:web', appLabel: 'Searching', kind: 'web' };
  }
  if (['invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message', 'run_workflow', 'swarm'].includes(name)) {
    return { groupKey: 'builtin:agent', appLabel: 'Helper agents', kind: 'agent' };
  }
  if (['manage_task', 'command_status', 'send_command_input', 'read_terminal', 'schedule'].includes(name)) {
    return { groupKey: 'builtin:task', appLabel: 'Running commands', kind: 'task' };
  }
  if (['exit_plan_mode', 'enter_plan_mode'].includes(name)) {
    return { groupKey: 'builtin:plan', appLabel: 'Other tools', kind: 'plan' };
  }
  if (name === 'ask_question') {
    return { groupKey: 'builtin:ask', appLabel: 'Other tools', kind: 'ask' };
  }
  return {
    groupKey: `other:${name || 'tool'}`,
    appLabel: name ? `Used ${name}` : 'Other tools',
    rawName: name || 'tool',
    kind: 'other',
  };
}

function shortFileName(rawPath) {
  const clean = unquoteArg(String(rawPath || '')).trim();
  if (!clean) return '';
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
}

function formatFileList(files, totalCount) {
  if (!files.length) return '';
  const shown = files.slice(0, 3);
  const extra = Math.max(0, totalCount - shown.length, files.length - shown.length);
  return `${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}

function phraseForToolGroup(c, n, details = {}, compact = false) {
  const files = details.files || [];
  const summaries = details.summaries || [];
  switch (c.kind) {
    case 'mcp':
      return `Used ${c.appShort} (${n} action${n === 1 ? '' : 's'})`;
    case 'appcmd':
      return n === 1 ? `Ran a ${c.appShort} command` : `Ran ${n} ${c.appShort} commands`;
    case 'read':
      if (!compact && files.length === 1 && n === 1) return `Read ${files[0]}`;
      if (!compact && files.length > 0) return `Read ${n} files (${formatFileList(files, n)})`;
      return n === 1 ? 'Read a file' : `Read ${n} files`;
    case 'edit':
      if (!compact && files.length === 1 && n === 1) return `Edited ${files[0]}`;
      if (!compact && files.length > 0) return n === 1 ? `Edited ${files[0]}` : `Edited ${files.length === 1 ? files[0] : `${files.length} files (${formatFileList(files, files.length)})`}`;
      return n === 1 ? 'Edited a file' : `Edited files ${n} times`;
    case 'write':
      if (!compact && files.length === 1 && n === 1) return `Wrote ${files[0]}`;
      if (!compact && files.length > 0) return `Wrote ${n} files (${formatFileList(files, n)})`;
      return n === 1 ? 'Wrote a file' : `Wrote ${n} files`;
    case 'cmd':
      if (!compact && summaries.length > 0) {
        return n === 1
          ? `Ran command: ${summaries[0]}`
          : `Ran ${n} commands (${summaries[0]}${n > 1 ? '…' : ''})`;
      }
      return n === 1 ? 'Ran a command' : `Ran ${n} commands`;
    case 'search':
      return 'Searched files';
    case 'list':
      return n === 1 ? 'Listed a folder' : `Listed ${n} folders`;
    case 'web':
      return 'Searched the web';
    case 'agent':
      return n === 1 ? 'Ran a helper agent' : `Ran helper agents (${n} actions)`;
    case 'task':
      return 'Checked a background task';
    case 'plan':
      return 'Finished planning step';
    case 'ask':
      return 'Asked you a question';
    default:
      return n === 1 ? `Used ${c.rawName}` : `Used ${c.rawName} (${n} actions)`;
  }
}

function lowerSecondClause(phrase) {
  return phrase.replace(/^(Read|Ran|Edited|Wrote|Searched|Listed|Checked|Finished|Asked)\b/, (w) => w.toLowerCase());
}

function describeStepSentence({ toolCalls, userSnippet, compacted, turnNumber }) {
  if (turnNumber === 1) {
    return userSnippet ? `Your first prompt: "${userSnippet}"` : 'Started this chat';
  }
  if (compacted) {
    return 'Memory was summarized here';
  }
  if (Array.isArray(toolCalls) && toolCalls.length) {
    const groups = new Map();
    for (const tc of toolCalls) {
      const cls = classifyToolCall(tc);
      const args = tc?.args || tc?.arguments || {};
      const phraseKey = `${cls.kind}:${cls.groupKey}`;
      let g = groups.get(phraseKey);
      if (!g) {
        g = { cls, count: 0, files: [], summaries: [] };
        groups.set(phraseKey, g);
      }
      g.count += 1;
      if (cls.kind === 'read' || cls.kind === 'edit' || cls.kind === 'write') {
        const fn = shortFileName(args.Path || args.path || args.TargetFile || args.AbsolutePath || '');
        if (fn && !g.files.includes(fn)) g.files.push(fn);
      } else if (cls.kind === 'cmd') {
        const sum = unquoteArg(String(args.toolSummary || '')).trim();
        if (sum) {
          const shortSum = sum.length > 44 ? `${sum.slice(0, 43)}…` : sum;
          if (!g.summaries.includes(shortSum)) g.summaries.push(shortSum);
        }
      }
    }
    const compact = groups.size >= 3;
    const phrases = [...groups.values()].slice(0, 3).map((g) => phraseForToolGroup(g.cls, g.count, g, compact));
    if (phrases.length === 1) return phrases[0];
    if (phrases.length === 2) return `${phrases[0]} and ${lowerSecondClause(phrases[1])}`;
    return `${phrases[0]}, ${lowerSecondClause(phrases[1])}, and ${lowerSecondClause(phrases[2])}`;
  }
  if (userSnippet) {
    return `Your prompt: "${userSnippet}"`;
  }
  return `Step ${turnNumber}`;
}

function summarizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  const counts = new Map();
  for (const tc of toolCalls) {
    const name = typeof tc?.name === 'string' && tc.name ? tc.name : 'tool';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
}

function isToolResultStep(step) {
  const t = step?.type || '';
  return (
    t === 'GENERIC' ||
    t === 'VIEW_FILE' ||
    t === 'GREP_SEARCH' ||
    t === 'RUN_COMMAND' ||
    t === 'LIST_DIRECTORY' ||
    t === 'CODE_ACTION'
  );
}

/**
 * Parse raw JSONL text from transcript.jsonl into structured context telemetry.
 */
export function parseTranscript(jsonlText, conversationId = '') {
  const lines = typeof jsonlText === 'string' ? jsonlText.split(/\r?\n/) : [];
  const steps = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    try {
      steps.push(JSON.parse(line));
    } catch {
      // Ignore partial line while file is actively being appended.
    }
  }
  return parseSteps(steps, conversationId);
}

/**
 * Analyze already-parsed transcript steps (used by the incremental reader).
 */
export function parseSteps(steps, conversationId = '') {

  let firstUserSnippet = '';
  let lastUserSnippet = '';
  let latestModelRaw = '';
  let userMessageCount = 0;
  let windowPromptCount = 0;
  let cumulativeInputTokens = 0;
  let cumulativeCacheReadTokens = 0;
  let cumulativeOutputTokens = 0;

  const turns = [];
  const compactions = [];

  let prevContextTokens = 0;
  let sawCheckpointSincePrevTurn = false;
  let trailingCheckpoint = null;
  let pendingTriggerTools = [];
  let pendingToolCalls = [];
  let pendingTriggerUser = '';
  let currentPromptSnippet = '';
  let pendingIsUserPrompt = false;
  let lastPlannerStepIndex = -1;
  let lastValidPlannerIdx = -1;

  // Track raw bucket estimates per epoch (reset when compaction occurs)
  const freshBuckets = () => ({
    systemBase: 0,
    userPrompts: 0,
    assistantAndThinking: 0,
    toolOutputs: 0,
    systemNotices: 0,
  });

  let buckets = freshBuckets();
  let epochStartTurn = 0;
  let epochBaseSet = false;
  let firstTurnBaseTokens = 0;
  let pendingExtraTokens = 0;
  let lastTimestamp = null;

  /*
   * Step 2.1 Empirical Findings from local transcript.jsonl files (read-only):
   * 1. MCP tool calls appear as tool_calls[].name === "call_mcp_tool" with JSON-quoted
   *    args.ServerName (e.g. "\"blender\"") and args.ToolName, or as <app>_* / mcp_<server>_*.
   *    Creative apps (Maya via mayapy/socket 7001, Blender, Nuke, Photoshop, Inkscape) also
   *    frequently run via run_command.
   * 2. Tool-result steps (GENERIC, VIEW_FILE, RUN_COMMAND, etc.) carry NO tool_call_id or
   *    tool_name — they follow their PLANNER_RESPONSE step sequentially in 1:1 order.
   *    Image results (e.g. get_viewport_screenshot with media) have tiny content text while
   *    their actual image size shows up in the next PLANNER_RESPONSE's server deltaTokens.
   * 3. AGENTS.md, user rules, and skills never appear inside transcript.jsonl; their combined
   *    overhead + tool list is captured solely in Turn 1's firstTurnBaseTokens.
   */
  let pendingCallsWithSizes = [];
  let resultCursor = 0;
  let prevTurnReplyNonToolEst = 0;
  let betweenUserEst = 0;
  let betweenSysEst = 0;
  let windowAppMap = new Map();
  const fullAppMap = new Map();

  const addAppUsage = (map, cls, addTokens, stepSingle) => {
    const cur = map.get(cls.groupKey) || {
      key: cls.groupKey,
      app: cls.appLabel,
      kind: cls.kind,
      tokens: 0,
      calls: 0,
      biggestSingle: 0,
    };
    cur.tokens += addTokens;
    cur.calls += 1;
    if (stepSingle > cur.biggestSingle) cur.biggestSingle = stepSingle;
    map.set(cls.groupKey, cur);
  };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') continue;
    if (typeof s.model === 'string') {
      const trimmedModel = s.model.trim();
      if (trimmedModel && trimmedModel.toLowerCase() !== 'unknown') {
        latestModelRaw = trimmedModel;
      }
    }
    if (s.created_at) lastTimestamp = s.created_at;
    const type = s.type || '';
    const stepIndex = Number.isFinite(Number(s.step_index)) ? Number(s.step_index) : i;

    if (type === 'USER_INPUT') {
      const snippet = extractUserSnippet(s.content);
      const isCompactCmd = /^\/compact\b/i.test((snippet || '').trim());
      if (!isCompactCmd) {
        userMessageCount++;
        windowPromptCount++;
        if (snippet) {
          if (!firstUserSnippet) firstUserSnippet = snippet;
          lastUserSnippet = snippet;
          currentPromptSnippet = snippet;
        }
        pendingTriggerUser = snippet;
        pendingIsUserPrompt = true;
      }
      const est = estimateCharsTokens(s.content);
      buckets.userPrompts += est;
      if (lastPlannerStepIndex >= 0) {
        pendingExtraTokens += est;
        betweenUserEst += est;
      }
      continue;
    }

    if (type === 'CHECKPOINT' || type === 'CONVERSATION_HISTORY') {
      sawCheckpointSincePrevTurn = true;
      const outTok = Math.max(0, Number(s.output_tokens) || 0);
      const contentEst = estimateCharsTokens(s.content);
      const summaryEst = outTok > 0
        ? outTok
        : s.truncated_fields
          ? Math.max(3200, contentEst)
          : Math.max(1200, contentEst);
      buckets.systemNotices += summaryEst;
      trailingCheckpoint = {
        stepIndex,
        timestamp: s.created_at || null,
        summaryTokens: summaryEst,
      };
      pendingExtraTokens = 0;
      betweenUserEst = 0;
      betweenSysEst = 0;
      pendingCallsWithSizes = [];
      resultCursor = 0;
      continue;
    }

    if (type === 'SYSTEM_MESSAGE' || type === 'ERROR_MESSAGE') {
      const est = estimateCharsTokens(s.content);
      buckets.systemNotices += est;
      if (lastPlannerStepIndex >= 0) {
        pendingExtraTokens += est;
        betweenSysEst += est;
      }
      continue;
    }

    if (isToolResultStep(s)) {
      const est = estimateCharsTokens(s.content);
      buckets.toolOutputs += est;
      if (lastPlannerStepIndex >= 0) pendingExtraTokens += est;
      if (pendingCallsWithSizes.length > 0) {
        const targetIdx = Math.min(resultCursor, pendingCallsWithSizes.length - 1);
        pendingCallsWithSizes[targetIdx].resultCharsEst += est;
        resultCursor++;
      }
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const inputTokens = Math.max(0, Number(s.input_tokens) || 0);
      const cacheReadTokens = Math.max(0, Number(s.cache_read_tokens) || 0);
      const outputTokens = Math.max(0, Number(s.output_tokens) || 0);
      const contextTokens = inputTokens + cacheReadTokens;
      const stepModel = typeof s.model === 'string' ? s.model.trim() : '';
      const modelRaw = stepModel && stepModel.toLowerCase() !== 'unknown' ? stepModel : latestModelRaw;
      if (modelRaw) latestModelRaw = modelRaw;

      const toolLabels = summarizeToolCalls(s.tool_calls);

      // Ignore empty/aborted planner steps where server reported 0 prompt tokens.
      if (contextTokens === 0) {
        if (toolLabels.length) pendingTriggerTools = pendingTriggerTools.concat(toolLabels);
        if (Array.isArray(s.tool_calls) && s.tool_calls.length) {
          pendingToolCalls = pendingToolCalls.concat(s.tool_calls);
          for (const tc of s.tool_calls) {
            pendingCallsWithSizes.push({
              cls: classifyToolCall(tc),
              callCharsEst: Math.ceil(JSON.stringify(tc).length / 4),
              resultCharsEst: 0,
            });
          }
        }
        continue;
      }

      cumulativeInputTokens += inputTokens;
      cumulativeCacheReadTokens += cacheReadTokens;
      cumulativeOutputTokens += outputTokens;

      const turnNumber = turns.length + 1;
      const sharpDrop = prevContextTokens > 20_000 && contextTokens < prevContextTokens * 0.72;
      const compacted = sawCheckpointSincePrevTurn || sharpDrop;

      if (compacted && prevContextTokens > 0) {
        const saved = Math.max(0, prevContextTokens - contextTokens);
        compactions.push({
          turn: turnNumber,
          stepIndex,
          beforeTokens: prevContextTokens,
          afterTokens: contextTokens,
          savedTokens: saved,
          timestamp: s.created_at || null,
          reason: sawCheckpointSincePrevTurn ? 'checkpoint' : 'drop',
        });
        buckets = freshBuckets();
        buckets.systemBase = contextTokens;
        epochStartTurn = turnNumber - 1;
        windowPromptCount = pendingIsUserPrompt ? 1 : 0;
        epochBaseSet = true;
      } else if (!epochBaseSet) {
        // Turn 1 exact baseline: server input_tokens minus first user prompt estimate.
        const baseEst = Math.max(0, contextTokens - buckets.userPrompts);
        buckets.systemBase = baseEst;
        firstTurnBaseTokens = baseEst;
        epochBaseSet = true;
      }

      const deltaTokens = prevContextTokens > 0 ? contextTokens - prevContextTokens : contextTokens;
      const cacheHitRate = contextTokens > 0 ? cacheReadTokens / contextTokens : 0;

      // Attribute the server deltaTokens from the previous step's tool calls to each app/group.
      if (compacted) {
        windowAppMap = new Map();
      } else if (pendingCallsWithSizes.length > 0 && deltaTokens > 0 && prevContextTokens > 0) {
        const rawToolSum = pendingCallsWithSizes.reduce((sSum, c) => sSum + c.callCharsEst + c.resultCharsEst, 0);
        const nonToolEst = prevTurnReplyNonToolEst + betweenUserEst + betweenSysEst;
        let stepToolTokens = 0;
        if (rawToolSum === 0) {
          stepToolTokens = Math.max(0, deltaTokens - nonToolEst);
        } else if (nonToolEst <= 0) {
          stepToolTokens = deltaTokens;
        } else if (deltaTokens > nonToolEst) {
          stepToolTokens = deltaTokens - nonToolEst;
        } else {
          stepToolTokens = Math.max(0, Math.round(deltaTokens * (rawToolSum / (rawToolSum + nonToolEst))));
        }

        if (stepToolTokens > 0) {
          const nCalls = pendingCallsWithSizes.length;
          for (const item of pendingCallsWithSizes) {
            const share = rawToolSum > 0
              ? stepToolTokens * ((item.callCharsEst + item.resultCharsEst) / rawToolSum)
              : stepToolTokens / nCalls;
            addAppUsage(windowAppMap, item.cls, share, share);
            addAppUsage(fullAppMap, item.cls, share, share);
          }
        }
      }

      // Describe what drove the memory jump arriving at this step in plain English.
      const triggerLabel = describeStepSentence({
        toolCalls: pendingToolCalls,
        userSnippet: pendingTriggerUser,
        compacted,
        turnNumber,
      });

      turns.push({
        turn: turnNumber,
        stepIndex,
        timestamp: s.created_at || null,
        model: modelRaw || 'unknown',
        contextTokens,
        deltaTokens,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        cacheHitRate,
        compacted,
        isPromptStart: pendingIsUserPrompt,
        promptNumber: userMessageCount,
        promptSnippet: currentPromptSnippet,
        tools: [...pendingTriggerTools],
        triggerLabel,
      });

      // Add this turn's model output + tool_calls into the bucket for subsequent turns.
      const toolCallsChars = s.tool_calls ? JSON.stringify(s.tool_calls).length : 0;
      const toolCallEst = Math.ceil(toolCallsChars / 4);
      const replyEst = Math.max(outputTokens - toolCallEst, Math.min(outputTokens, estimateCharsTokens(s.content) + estimateCharsTokens(s.thinking)));
      buckets.assistantAndThinking += Math.max(0, replyEst);
      buckets.toolOutputs += toolCallEst;

      prevContextTokens = contextTokens;
      sawCheckpointSincePrevTurn = false;
      trailingCheckpoint = null;
      pendingTriggerTools = toolLabels;
      pendingToolCalls = Array.isArray(s.tool_calls) ? [...s.tool_calls] : [];
      pendingCallsWithSizes = Array.isArray(s.tool_calls)
        ? s.tool_calls.map((tc) => ({
            cls: classifyToolCall(tc),
            callCharsEst: Math.ceil(JSON.stringify(tc).length / 4),
            resultCharsEst: 0,
          }))
        : [];
      resultCursor = 0;
      prevTurnReplyNonToolEst = Math.max(0, replyEst);
      betweenUserEst = 0;
      betweenSysEst = 0;
      pendingTriggerUser = '';
      pendingIsUserPrompt = false;
      lastPlannerStepIndex = stepIndex;
      lastValidPlannerIdx = i;
      pendingExtraTokens = 0;
    }
  }

  let justCompacted = false;
  let justCompactedSaved = 0;
  if (sawCheckpointSincePrevTurn && trailingCheckpoint && prevContextTokens > 0) {
    const baseEst = firstTurnBaseTokens > 0 ? firstTurnBaseTokens : Math.min(15_000, prevContextTokens);
    const postCompactTokens = baseEst + trailingCheckpoint.summaryTokens + pendingExtraTokens;
    const saved = Math.max(0, prevContextTokens - postCompactTokens);
    const turnNumber = turns.length + 1;

    compactions.push({
      turn: turnNumber,
      stepIndex: trailingCheckpoint.stepIndex,
      beforeTokens: prevContextTokens,
      afterTokens: postCompactTokens,
      savedTokens: saved,
      timestamp: trailingCheckpoint.timestamp,
      reason: 'checkpoint',
      pending: true,
    });

    buckets = freshBuckets();
    buckets.systemBase = baseEst;
    buckets.systemNotices = trailingCheckpoint.summaryTokens;
    if (pendingExtraTokens > 0) {
      buckets.userPrompts += pendingExtraTokens;
    }

    turns.push({
      turn: turnNumber,
      stepIndex: trailingCheckpoint.stepIndex,
      timestamp: trailingCheckpoint.timestamp,
      model: latestModelRaw || 'unknown',
      contextTokens: postCompactTokens,
      deltaTokens: postCompactTokens - prevContextTokens,
      inputTokens: postCompactTokens,
      cacheReadTokens: 0,
      outputTokens: trailingCheckpoint.summaryTokens,
      cacheHitRate: 0,
      compacted: true,
      provisional: true,
      isPromptStart: false,
      promptNumber: userMessageCount,
      promptSnippet: currentPromptSnippet,
      tools: [],
      triggerLabel: 'Memory was summarized here',
    });

    epochStartTurn = turns.length - 1;
    windowPromptCount = 0;
    lastValidPlannerIdx = steps.length - 1;
    pendingExtraTokens = 0;
    windowAppMap = new Map();
    justCompacted = true;
    justCompactedSaved = saved;
  }

  if (turns.length > 0 && userMessageCount === 0) {
    userMessageCount = 1;
    if (windowPromptCount === 0) windowPromptCount = 1;
  }

  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const modelSpec = inferModelSpec(latestModelRaw);

  // If no valid planner turn yet, fall back to rough estimate of initial user input.
  const exactContextTokens = latestTurn ? latestTurn.contextTokens : 0;
  const latestOutputTokens = latestTurn ? latestTurn.outputTokens : 0;
  const latestInputTokens = latestTurn ? latestTurn.inputTokens : 0;
  const latestCacheReadTokens = latestTurn ? latestTurn.cacheReadTokens : 0;
  const cacheHitRate = latestTurn ? latestTurn.cacheHitRate : 0;

  // Determine whether steps arrived after the last valid planner response (mid-turn activity).
  const isActiveTurn = lastValidPlannerIdx >= 0 && lastValidPlannerIdx < steps.length - 1;
  const projectedNextTokens = exactContextTokens + latestOutputTokens + (isActiveTurn ? pendingExtraTokens : 0);

  // Reconcile category buckets proportionally to match exactContextTokens exactly.
  const categories = reconcileCategories(buckets, exactContextTokens);
  const toolCatTokens = categories.find((c) => c.key === 'toolOutputs')?.tokens || 0;

  const finalizeAppList = (map, capTotal) => {
    const rawList = [...map.values()].map((item) => ({
      app: item.app,
      kind: item.kind,
      tokens: Math.max(0, Math.round(item.tokens)),
      calls: item.calls,
      biggestSingle: Math.max(0, Math.round(item.biggestSingle)),
    }));
    const rawSum = rawList.reduce((acc, x) => acc + x.tokens, 0);
    if (Number.isFinite(capTotal) && rawSum > capTotal && rawSum > 0) {
      const scale = capTotal / rawSum;
      let running = 0;
      for (let idx = 0; idx < rawList.length; idx++) {
        const it = rawList[idx];
        it.tokens = idx === rawList.length - 1
          ? Math.max(0, capTotal - running)
          : Math.round(it.tokens * scale);
        running += it.tokens;
        it.biggestSingle = Math.min(it.tokens, Math.round(it.biggestSingle * scale));
      }
    }
    return rawList.filter((x) => x.calls > 0).sort((a, b) => b.tokens - a.tokens);
  };

  const toolCostByApp = finalizeAppList(windowAppMap, toolCatTokens);
  const toolCostByAppFull = finalizeAppList(fullAppMap, Infinity);

  // Heavy turns in the current (post-compaction) window, ranked by positive deltaTokens.
  const currentWindowTurns = turns.slice(epochStartTurn);
  const heavyTurns = currentWindowTurns
    .filter((t, idx) => !(idx === 0 && t.compacted) && t.deltaTokens > 0)
    .sort((a, b) => b.deltaTokens - a.deltaTokens)
    .slice(0, 6)
    .map((t) => ({
      turn: t.turn,
      stepIndex: t.stepIndex,
      deltaTokens: t.deltaTokens,
      contextTokens: t.contextTokens,
      tools: t.tools,
      triggerLabel: t.triggerLabel,
      promptNumber: t.promptNumber || 0,
      promptSnippet: t.promptSnippet || '',
      isPromptStart: Boolean(t.isPromptStart),
      timestamp: t.timestamp,
    }));

  const tableLimit = modelSpec.contextLimit;
  const maxCompactionBefore = compactions.reduce((mx, c) => Math.max(mx, c.beforeTokens || 0), 0);
  const isLearnedCeiling = maxCompactionBefore > tableLimit;
  const contextLimit = isLearnedCeiling
    ? Math.ceil(maxCompactionBefore / 8_000) * 8_000
    : tableLimit;
  const fmtWin = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1_000)}K`);
  const windowLabel = isLearnedCeiling ? `~${fmtWin(contextLimit)}` : modelSpec.windowLabel;
  const ceilingBadge = isLearnedCeiling
    ? `Auto (learned ~${fmtWin(contextLimit)})`
    : `Auto (est. ${modelSpec.windowLabel})`;

  const percentUsed = contextLimit > 0 ? (exactContextTokens / contextLimit) * 100 : 0;
  const remainingTokens = Math.max(0, contextLimit - exactContextTokens);

  return {
    conversationId,
    hasData: turns.length > 0,
    titleFallback: firstUserSnippet || (conversationId ? `Session ${conversationId.slice(0, 8)}` : 'No active session'),
    model: {
      raw: modelSpec.raw,
      displayName: modelSpec.displayName,
      contextLimit,
      tableLimit,
      isLearnedCeiling,
      windowLabel,
      ceilingBadge,
    },
    current: {
      exactContextTokens,
      projectedNextTokens,
      pendingExtraTokens: isActiveTurn ? pendingExtraTokens : 0,
      isActiveTurn,
      latestInputTokens,
      latestCacheReadTokens,
      latestOutputTokens,
      cacheHitRate,
      lastDeltaTokens: latestTurn ? latestTurn.deltaTokens : 0,
      percentUsed,
      remainingTokens,
      firstTurnBaseTokens,
      lastUserSnippet: lastUserSnippet || firstUserSnippet || '',
      justCompacted,
      justCompactedSaved,
    },
    totals: {
      turnCount: turns.length,
      currentWindowTurnCount: currentWindowTurns.length,
      userMessageCount,
      windowPromptCount,
      stepCount: steps.length,
      cumulativeInputTokens,
      cumulativeCacheReadTokens,
      cumulativeOutputTokens,
      compactionCount: compactions.length,
      totalCompactionSaved: compactions.reduce((acc, c) => acc + c.savedTokens, 0),
    },
    categories,
    toolCostByApp,
    toolCostByAppFull,
    turns,
    epochStartTurn,
    compactions,
    heavyTurns,
    lastUpdatedAt: lastTimestamp,
  };
}

function reconcileCategories(buckets, targetTotal) {
  const defs = [
    { key: 'systemBase', label: 'Fixed setup', colorVar: 'var(--cm-cat-base)', raw: Math.max(0, buckets.systemBase) },
    { key: 'toolOutputs', label: 'Tool results', colorVar: 'var(--cm-cat-tools)', raw: Math.max(0, buckets.toolOutputs) },
    { key: 'assistantAndThinking', label: "AI's replies and thinking", colorVar: 'var(--cm-cat-model)', raw: Math.max(0, buckets.assistantAndThinking) },
    { key: 'userPrompts', label: 'Your prompts', colorVar: 'var(--cm-cat-user)', raw: Math.max(0, buckets.userPrompts) },
    { key: 'systemNotices', label: 'System notes', colorVar: 'var(--cm-cat-sys)', raw: Math.max(0, buckets.systemNotices) },
  ];

  if (targetTotal <= 0) {
    return defs.map((d) => ({ key: d.key, label: d.label, colorVar: d.colorVar, tokens: 0, pct: 0 }));
  }

  // Keep systemBase anchored (clamped to targetTotal), scale variable categories to fill remainder.
  const baseTokens = Math.min(Math.round(defs[0].raw), targetTotal);
  const remainder = Math.max(0, targetTotal - baseTokens);
  const varDefs = defs.slice(1);
  const varRawSum = varDefs.reduce((s, d) => s + d.raw, 0);

  const result = [
    {
      key: defs[0].key,
      label: defs[0].label,
      colorVar: defs[0].colorVar,
      tokens: baseTokens,
      pct: (baseTokens / targetTotal) * 100,
    },
  ];

  let allocated = baseTokens;
  for (let i = 0; i < varDefs.length; i++) {
    const d = varDefs[i];
    let tokens = 0;
    if (varRawSum > 0) {
      tokens = i === varDefs.length - 1
        ? Math.max(0, targetTotal - allocated)
        : Math.round((d.raw / varRawSum) * remainder);
    }
    allocated += tokens;
    result.push({
      key: d.key,
      label: d.label,
      colorVar: d.colorVar,
      tokens,
      pct: (tokens / targetTotal) * 100,
    });
  }

  // If all variable buckets were 0 but remainder > 0, attribute remainder to systemBase.
  if (allocated < targetTotal) {
    result[0].tokens += targetTotal - allocated;
    result[0].pct = (result[0].tokens / targetTotal) * 100;
  }

  return result;
}
