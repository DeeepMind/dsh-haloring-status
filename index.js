import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DSH HaloRing 状态桥（宿主插件）
 *
 * 观察宿主公开的会话事件与 Agent 状态，写出一个行式状态文件，
 * 供托盘环形指示灯（DshHaloRing）读取。不读取对话正文，也不修改会话。
 *
 * 输出：%USERPROFILE%\.dsh\dsh-status.txt
 *
 *   version=1
 *   state=running
 *   priority=2
 *   updated=1793210745187      ← Unix 毫秒
 *   pid=12716
 *   detail=Agent 运行中（turn 35）
 *   progress=44                ← 0..100，非精确提示
 *   attention=0
 *   approvals=0
 *   turns=1
 *   sessions=1
 *   completed=0
 *   degraded=0
 *   error=0
 *
 * 状态优先级（不是“最后事件优先”）：
 *   故障 > 降级 > 等待授权 > 运行中 > 完成 > 空闲
 */

const PRIORITY = {
  offline: -1,
  idle: 0,
  completed: 1,
  running: 2,
  attention: 3,
  degraded: 4,
  error: 5,
};

/**
 * 进度提示（非精确百分比）。
 *
 * 托盘环的弧长只是“正在推进”的视觉提示，不承诺准确度。
 * 依据 turn/step 事件推算：
 *   - turn 开始即给 base（25，便于一眼看出在工作）
 *   - 每完成一个 step 递增，用渐近曲线避免长任务顶满
 *   - 上限 95，只有 turn/end 才到 100
 * 因为“总步数未知”，刻意不用线性分母，避免卡在某个数字不动的观感。
 */
const PROGRESS = {
  base: 25,          // turn 开始时的起始进度
  cap: 95,           // 未结束前永不到 100
  toolBonus: 8,      // 工具执行中额外加成，体现“正在干活”
  decay: 3.2,        // 渐近曲线衰减系数：越大越快逼近上限
};

function progressForTurn(completedSteps, toolRunning) {
  // 渐近：base + (cap-base) * (1 - e^(-steps/decay))
  const span = PROGRESS.cap - PROGRESS.base;
  let p = PROGRESS.base + span * (1 - Math.exp(-completedSteps / PROGRESS.decay));
  if (toolRunning) p += PROGRESS.toolBonus;
  return Math.max(0, Math.min(PROGRESS.cap, Math.round(p)));
}

function nowMs() {
  return Date.now();
}

function safeString(value, max = 240) {
  let text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (text.length > max) text = text.slice(0, max - 1) + '…';
  return text;
}

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const statusFile = path.join(dshHome, 'dsh-status.txt');

  const liveAgents = new Set();
  const activeTurns = new Map();       // sessionId -> { turn, startedAt, steps, toolRunning }
  const settledSessions = new Set();   // turn ended; ignore stale agent.running until next turn
  const pendingApprovals = new Map();  // approval id -> { sessionId, tool }
  const lastSeq = new Map();           // sessionId -> last processed event seq

  let errorActive = false;
  let degradedUntil = 0;
  let completedUntil = 0;
  let lastDetail = '';
  let lastWrite = 0;
  let timer = null;

  const writeNow = () => {
    const t = nowMs();
    if (completedUntil && completedUntil <= t) completedUntil = 0;
    if (degradedUntil && degradedUntil <= t) degradedUntil = 0;
    let state = 'idle';
    let detail = 'DSH 空闲';
    let priority = PRIORITY.idle;
    let progress = 0;

    if (errorActive) {
      state = 'error';
      priority = PRIORITY.error;
      detail = lastDetail || 'DSH 故障/阻塞';
      progress = 100;
    } else if (degradedUntil > t) {
      state = 'degraded';
      priority = PRIORITY.degraded;
      detail = lastDetail || 'DSH 降级运行';
      // 降级时进度冻结在当前位置，用半程值示意“有进展但不顺”
      progress = 50;
    } else if (pendingApprovals.size > 0) {
      state = 'attention';
      priority = PRIORITY.attention;
      const first = pendingApprovals.values().next().value;
      detail = first?.tool ? `等待授权：${first.tool}` : '等待授权/审批';
      // 等待审批时进度冻结在 base，表示“卡住了但没失败”
      progress = PROGRESS.base;
    } else if (activeTurns.size > 0) {
      state = 'running';
      priority = PRIORITY.running;
      const first = activeTurns.values().next().value;
      detail = first?.turn ? `Agent 运行中（turn ${first.turn}）` : 'Agent 运行中';
      progress = progressForTurn(first?.steps || 0, first?.toolRunning || false);
    } else if (completedUntil > t) {
      state = 'completed';
      priority = PRIORITY.completed;
      detail = '回合完成';
      progress = 100;
    } else {
      state = 'idle';
      priority = PRIORITY.idle;
      detail = 'DSH 空闲';
      progress = 0;
    }

    const body = [
      'version=1',
      `state=${state}`,
      `priority=${priority}`,
      `updated=${t}`,
      `pid=${process.pid}`,
      `detail=${safeString(detail)}`,
      `progress=${progress}`,
      `attention=${pendingApprovals.size}`,
      `approvals=${pendingApprovals.size}`,
      `turns=${activeTurns.size}`,
      `sessions=${liveAgents.size}`,
      `completed=${completedUntil > t ? 1 : 0}`,
      `degraded=${degradedUntil > t ? 1 : 0}`,
      `error=${errorActive ? 1 : 0}`,
      '',
    ].join('\n');

    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, body, 'utf8');
      lastWrite = t;
    } catch {
      // 只读的主目录不应该把 Harness 拖垮。
      // 托盘指示灯会显示离线，直到该文件重新可写。
    }
  };

  const schedule = () => {
    const t = nowMs();
    if (t - lastWrite >= 250) {
      writeNow();
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        writeNow();
      }, 250);
      timer.unref?.();
    }
  };

  const handleEvent = (sessionId, event) => {
    if (!sessionId || !event) return;
    const type = event.type;
    const data = event.data || {};

    switch (type) {
      case 'turn/start':
        activeTurns.set(sessionId, {
          turn: data.turn,
          startedAt: nowMs(),
          steps: 0,            // 已完成的 step 数
          toolRunning: false,  // 是否正在执行工具
        });
        settledSessions.delete(sessionId);
        if (timer !== null) { clearTimeout(timer); timer = null; }
        completedUntil = 0;
        errorActive = false;
        degradedUntil = 0;
        lastDetail = '';
        break;

      // 一个 step = 一次「模型推理 → 工具调用 → 工具执行完毕」循环
      case 'step/start': {
        const t0 = activeTurns.get(sessionId);
        if (t0) { t0.toolRunning = false; t0.step = data.step; }
        break;
      }

      case 'step/end': {
        const t1 = activeTurns.get(sessionId);
        if (t1) { t1.steps = (t1.steps || 0) + 1; t1.toolRunning = false; }
        break;
      }

      // 工具调用开始/结束：用于显示“正在执行工具”的瞬时加成
      case 'tool/call': {
        const t2 = activeTurns.get(sessionId);
        if (t2) { t2.toolRunning = true; t2.lastTool = data.name || ''; }
        break;
      }

      case 'tool/result': {
        const t3 = activeTurns.get(sessionId);
        if (t3) { t3.toolRunning = false; }
        break;
      }

      case 'turn/end': {
        activeTurns.delete(sessionId);
        settledSessions.add(sessionId);
        if (timer !== null) { clearTimeout(timer); timer = null; }
        const kind = data.reason?.kind || 'completed';
        if (kind === 'completed') {
          completedUntil = nowMs() + 1800;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            completedUntil = 0;
            writeNow();
          }, 1800);
          errorActive = false;
          degradedUntil = 0;
          lastDetail = '';
        } else if (kind === 'error' || kind === 'blocked') {
          errorActive = true;
          degradedUntil = 0;
          completedUntil = 0;
          lastDetail = data.reason?.reason?.message || data.reason?.message || `回合结束：${kind}`;
        } else if (kind === 'max-tokens') {
          degradedUntil = nowMs() + 10000;
          lastDetail = '上下文接近上限';
        } else if (kind === 'aborted' || kind === 'interrupted') {
          // A user stop is not a wait state and not an error.
        }
        break;
      }

      case 'approval/asked':
        pendingApprovals.set(data.id || `${sessionId}:${data.callId}`, {
          sessionId,
          tool: data.toolName || data.tool || '',
        });
        lastDetail = data.reason || '等待授权/审批';
        break;

      case 'approval/decided':
        pendingApprovals.delete(data.id);
        break;

      case 'compaction/start':
        degradedUntil = nowMs() + 12000;
        lastDetail = '上下文压缩中';
        break;

      case 'compaction/end':
        // Keep the rest of the current turn; the next request clears it.
        if (degradedUntil > nowMs()) degradedUntil = nowMs() + 1500;
        break;

      case 'llm/retry':
      case 'llm/retry-started':
        degradedUntil = nowMs() + 8000;
        lastDetail = data.failure?.message
          ? `Provider 重试：${data.failure.message}`
          : 'Provider 异常，正在重试';
        break;

      case 'assistant/attempt': {
        const stream = Array.isArray(data.stream) ? data.stream : [];
        const finish = [...stream].reverse().find((frame) => frame?.chunk?.type === 'finish');
        if (finish?.chunk?.reason?.kind === 'error') {
          degradedUntil = nowMs() + 8000;
          lastDetail = finish.chunk.reason.failure?.message || '模型请求失败，正在重试';
        }
        break;
      }

      case 'assistant/message':
        if (degradedUntil) degradedUntil = 0;
        break;

      default:
        break;
    }

    schedule();
  };

  const pollSessions = () => {
    let sessions = [];
    try {
      sessions = ctx.sessions.list();
    } catch {
      return;
    }

    const live = new Set();
    for (const session of sessions)
    {
      const sessionId = session?.id;
      if (!sessionId) continue;
      live.add(sessionId);

      let seq = 0;
      try { seq = Number(session.seq) || 0; } catch { seq = 0; }
      let last = lastSeq.get(sessionId);
      if (last === undefined)
      {
        last = Math.max(0, seq - 300);
        lastSeq.set(sessionId, last);
      }
      for (let i = last; i < seq; ++i)
      {
        try
        {
          const event = session.eventAt(i);
          if (event) handleEvent(sessionId, event);
        }
        catch { /* session may be closing */ }
      }
      lastSeq.set(sessionId, seq);

      let running = false;
      try { running = ctx.agents.get(sessionId)?.status === 'running'; } catch { }
      if (running && !activeTurns.has(sessionId) &&
          !settledSessions.has(sessionId) && pendingApprovals.size === 0)
        activeTurns.set(sessionId, { turn: null, startedAt: nowMs() });
    }

    liveAgents.clear();
    for (const id of live) liveAgents.add(id);
    for (const id of [...lastSeq.keys()])
    {
      if (!live.has(id))
      {
        lastSeq.delete(id);
        activeTurns.delete(id);
        settledSessions.delete(id);
        for (const [key, value] of pendingApprovals)
          if (value.sessionId === id) pendingApprovals.delete(key);
      }
    }
  };

  ctx.effect(() =>
  {
    const poll = setInterval(() =>
    {
      pollSessions();
      if (nowMs() - lastWrite >= 1000) writeNow();
    }, 300);
    poll.unref?.();

    const heartbeat = setInterval(() =>
    {
      if (completedUntil && completedUntil <= nowMs()) completedUntil = 0;
      if (degradedUntil && degradedUntil <= nowMs()) degradedUntil = 0;
      writeNow();
    }, 1000);
    heartbeat.unref?.();

    pollSessions();
    writeNow();
    return () =>
    {
      clearInterval(poll);
      clearInterval(heartbeat);
      if (timer !== null)
      {
        clearTimeout(timer);
        timer = null;
      }
    };
  });
}

export const inject = ['sessions', 'agents'];
export const name = 'dsh-haloring-status';
