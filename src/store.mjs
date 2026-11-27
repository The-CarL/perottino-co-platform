import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isValidEmployeeLimit, maxCompanyEmployees } from './headcount.mjs';

function ownerMessage(turn) {
  return { id: turn.id, author: turn.sender_agent_id ? 'employee' : 'owner', text: turn.text, createdAt: turn.created_at,
    ...(turn.sender_agent_id && {senderAgentId:turn.sender_agent_id}) };
}

function turnMessages(turn) {
  const messages = [ownerMessage(turn)];
  if (turn.reply_id) {
    messages.push({ id: turn.reply_id, author: 'agent', text: turn.reply, createdAt: turn.completed_at });
  }
  return messages;
}

export function createStore(dataDir, {employeeLimit = Number(process.env.PEROTTINO_EMPLOYEE_LIMIT ?? maxCompanyEmployees)} = {}) {
  if (!isValidEmployeeLimit(employeeLimit))
    throw new Error(`Employee limit must be between 1 and ${maxCompanyEmployees}.`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, 'company.sqlite');
  closeSync(openSync(filename, 'a', 0o600));
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS agent (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT UNIQUE NOT NULL, role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn (
      seq INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agent(id),
      request_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sender_agent_id TEXT REFERENCES agent(id),
      created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','working','done','error')),
      attempts INTEGER NOT NULL DEFAULT 0,
      token TEXT,
      lease_until INTEGER,
      reply_id TEXT UNIQUE,
      reply TEXT,
      completed_at TEXT,
      UNIQUE (agent_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS turn_agent_order ON turn(agent_id, seq);
    CREATE INDEX IF NOT EXISTS turn_queue ON turn(state, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS one_worker_per_agent ON turn(agent_id) WHERE state='working';
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id),
      sourceMessageId TEXT NOT NULL REFERENCES turn(id), text TEXT NOT NULL, createdAt TEXT NOT NULL,
      UNIQUE (agent_id, text)
    );
    CREATE TABLE IF NOT EXISTS memory_action (
      seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id), request_id TEXT NOT NULL,
      memory_id TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES turn(id), method TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (agent_id, request_id)
    );
    INSERT OR IGNORE INTO agent (id, name, handle, role) VALUES ('ceo', 'Mara', 'mara', 'CEO');
    CREATE TABLE IF NOT EXISTS employment (
      agent_id TEXT PRIMARY KEY REFERENCES agent(id), manager_id TEXT REFERENCES agent(id),
      desired_state TEXT NOT NULL DEFAULT 'active', generation INTEGER NOT NULL DEFAULT 1, can_hire INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO employment(agent_id,can_hire) SELECT id, id='ceo' FROM agent;
    CREATE TABLE IF NOT EXISTS employment_action (
      agent_id TEXT NOT NULL REFERENCES agent(id), request_id TEXT NOT NULL, operation TEXT NOT NULL,
      PRIMARY KEY(agent_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS hire_receipt (
      turn_id TEXT PRIMARY KEY REFERENCES turn(id), agent_id TEXT NOT NULL REFERENCES agent(id)
    );
    CREATE TABLE IF NOT EXISTS goal (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id), request_id TEXT NOT NULL,
      turn_id TEXT UNIQUE NOT NULL REFERENCES turn(id), text TEXT NOT NULL, checkpoint TEXT NOT NULL DEFAULT '',
      blocked INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(agent_id,request_id)
    );
  `);

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Upgrade existing pilot databases in place before any dispatcher can claim a turn.
  transaction(() => {
    const columns = db.prepare('PRAGMA table_info(turn)').all().map(column => column.name);
    if (!columns.includes('attempts'))
      db.exec('ALTER TABLE turn ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('sender_agent_id'))
      db.exec('ALTER TABLE turn ADD COLUMN sender_agent_id TEXT REFERENCES agent(id)');
  });

  const getAgent = id => db.prepare('SELECT id, name, handle, role FROM agent WHERE id=?').get(id);
  function employee(id) {
    const row = db.prepare(`SELECT a.*, e.manager_id AS managerId,e.desired_state AS desiredState,
      e.generation, e.can_hire AS canHire FROM agent a JOIN employment e ON e.agent_id=a.id WHERE a.id=?`).get(id);
    if (!row) return null;
    return { ...row, canHire: Boolean(row.canHire), runtimeStatus: row.desiredState === 'active' ? 'Local worker' : 'Stopped' };
  }
  function mustAcceptWork(agentId) {
    if (employee(agentId)?.desiredState === 'fired')
      throw Object.assign(new Error('This employee has left the company.'), { code: 'EMPLOYEE_FIRED', status: 409 });
  }
  const goalQuery = `SELECT g.id,g.text,g.checkpoint,g.steps AS stepCount,g.created_at AS createdAt,g.updated_at AS updatedAt,
    CASE WHEN g.blocked=1 OR t.state='error' THEN 'blocked' WHEN t.state='queued' THEN 'ready' ELSE t.state END AS status
    FROM goal g JOIN turn t ON g.turn_id=t.id`;
  const getGoal = id => db.prepare(goalQuery + ' WHERE g.id=?').get(id);
  function insertGoal(agentId, text, requestId, senderAgentId = null) {
    const id = randomUUID(), turnId = randomUUID(), at = new Date().toISOString();
    db.prepare("INSERT INTO turn(id,agent_id,request_id,text,created_at,sender_agent_id,state) VALUES(?,?,?,?,?,?,'queued')")
      .run(turnId, agentId, 'goal/' + requestId, text, at, senderAgentId);
    db.prepare('INSERT INTO goal(id,agent_id,request_id,turn_id,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, agentId, requestId, turnId, text, at, at);
    return getGoal(id);
  }
  const getMemories = agentId => db.prepare(`
    SELECT m.id, m.text, m.sourceMessageId, m.createdAt, (
      SELECT a.created_at FROM memory_action a WHERE a.agent_id=m.agent_id AND a.memory_id=m.id AND a.method='PATCH'
      ORDER BY a.seq DESC LIMIT 1
    ) AS updatedAt FROM memory m WHERE m.agent_id=? ORDER BY m.rowid
  `).all(agentId).map(({ updatedAt, ...note }) => updatedAt ? { ...note, updatedAt, updatedBy: 'owner' } : note);
  const memoryRevision = agentId => db.prepare('SELECT MAX(seq) AS seq FROM memory_action WHERE agent_id=?').get(agentId).seq;
  const releaseStatement = db.prepare(
    "UPDATE turn SET state='queued', attempts=MAX(attempts-1,0), token=NULL, lease_until=NULL WHERE id=? AND state='working' AND token=?"
  );

  return {
    directory: () => db.prepare('SELECT id, name, handle, role FROM agent ORDER BY rowid').all(),
    getAgent,
    employee,
    listGoals: agentId => db.prepare(goalQuery + ' WHERE g.agent_id=? ORDER BY g.rowid DESC LIMIT 20').all(agentId),
    assignGoal(agentId, text, requestId) {
      return transaction(() => {
        const existing = db.prepare('SELECT id FROM goal WHERE agent_id=? AND request_id=?').get(agentId, requestId);
        if (existing) {
          const goal = getGoal(existing.id);
          return { goal, conflict: goal.text !== text };
        }
        mustAcceptWork(agentId);
        return { goal: insertGoal(agentId, text, requestId), conflict: false };
      });
    },
    setEmployeeState({ agentId, operation, requestId }) {
      return transaction(() => {
        const current = employee(agentId);
        if (!current) return { ok: false, status: 404 };
        const receipt = db.prepare('SELECT operation FROM employment_action WHERE agent_id=? AND request_id=?').get(agentId, requestId);
        if (receipt) return receipt.operation === operation ? { ok: true, employee: current } : { ok: false, status: 409 };
        const next = { pause: 'paused', resume: 'active', fire: 'fired' }[operation];
        if (!next) return { ok: false, status: 400 };
        if (current.desiredState === 'fired' && next !== 'fired') return { ok: false, status: 409 };
        if (current.desiredState !== next) {
          db.prepare('UPDATE employment SET desired_state=?,generation=generation+1 WHERE agent_id=?').run(next, agentId);
          if (next === 'paused') db.prepare(`UPDATE turn SET state='queued',attempts=MAX(attempts-1,0),token=NULL,lease_until=NULL
            WHERE agent_id=? AND state='working'`).run(agentId);
          if (next === 'fired') {
            db.prepare(`UPDATE goal SET blocked=1,checkpoint=?,updated_at=? WHERE agent_id=? AND turn_id IN
              (SELECT id FROM turn WHERE agent_id=? AND state IN ('queued','working'))`)
              .run('Employment ended before this goal was completed.', new Date().toISOString(), agentId, agentId);
            db.prepare("UPDATE turn SET state='error',token=NULL,lease_until=NULL WHERE agent_id=? AND state IN ('queued','working')").run(agentId);
          }
        }
        db.prepare('INSERT INTO employment_action(agent_id,request_id,operation) VALUES(?,?,?)').run(agentId, requestId, operation);
        return { ok: true, employee: employee(agentId) };
      });
    },
    hireForTurn(job, role, assignment) {
      return transaction(() => {
        const manager = employee(job.agent.id);
        const lease = db.prepare("SELECT id FROM turn WHERE id=? AND agent_id=? AND state='working' AND token=? AND lease_until>?")
          .get(job.message.id, job.agent.id, job.token, Date.now());
        if (!lease || manager?.desiredState !== 'active' || !manager.canHire) throw new Error('This employee cannot hire.');
        const existing = db.prepare('SELECT agent_id FROM hire_receipt WHERE turn_id=?').get(job.message.id);
        if (existing) return employee(existing.agent_id);
        if (db.prepare("SELECT COUNT(*) AS total FROM employment WHERE desired_state<>'fired'").get().total >= employeeLimit)
          throw Object.assign(new Error('Employee limit reached.'), {code:'EMPLOYEE_LIMIT'});
        if (typeof role !== 'string' || !role.trim() || role.length > 120) throw new Error('Invalid employee role.');
        const names = ['Iris','Robin','Ari','Sasha','Elio','Morgan','Sam','Nora'];
        const count = db.prepare('SELECT COUNT(*) AS n FROM agent').get().n - 1;
        const base = names[count % names.length], suffix = Math.floor(count / names.length);
        const name = base + (suffix ? ' ' + (suffix + 1) : ''), handle = name.toLowerCase().replace(' ', '-');
        const id = randomUUID();
        db.prepare('INSERT INTO agent(id,name,handle,role) VALUES(?,?,?,?)').run(id, name, handle, role.trim());
        db.prepare('INSERT INTO employment(agent_id,manager_id) VALUES(?,?)').run(id, manager.id);
        db.prepare('INSERT INTO hire_receipt(turn_id,agent_id) VALUES(?,?)').run(job.message.id, id);
        if (assignment) insertGoal(id, assignment, 'hire/' + job.message.id, manager.id);
        return employee(id);
      });
    },
    getMemories,
    changeMemory(agentId, memoryId, method, requestId, text = '') {
      return transaction(() => {
        const hash = createHash('sha256').update(text).digest('hex');
        const receipt = db.prepare('SELECT * FROM memory_action WHERE agent_id=? AND request_id=?').get(agentId, requestId);
        if (receipt) {
          return receipt.memory_id === memoryId && receipt.method === method && receipt.content_hash === hash ? 'ok' : 'conflict';
        }
        const note = db.prepare('SELECT sourceMessageId FROM memory WHERE agent_id=? AND id=?').get(agentId, memoryId);
        if (!note) return 'missing';
        if (method === 'PATCH') {
          if (db.prepare('SELECT 1 FROM memory WHERE agent_id=? AND id<>? AND text=?').get(agentId, memoryId, text))
            return 'duplicate';
          db.prepare('UPDATE memory SET text=? WHERE agent_id=? AND id=?').run(text, agentId, memoryId);
        } else {
          db.prepare('DELETE FROM memory WHERE agent_id=? AND id=?').run(agentId, memoryId);
        }
        db.prepare(`
          INSERT INTO memory_action (agent_id, request_id, memory_id, source_message_id, method, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(agentId, requestId, memoryId, note.sourceMessageId, method, hash, new Date().toISOString());
        return 'ok';
      });
    },
    messages(agentId) {
      const turns = db.prepare('SELECT * FROM turn WHERE agent_id=? ORDER BY seq').all(agentId);
      let status = 'idle';
      if (turns.some(turn => turn.state === 'working')) status = 'working';
      else if (turns.some(turn => turn.state === 'queued')) status = 'queued';
      else if (turns.at(-1)?.state === 'error') status = 'error';
      const result = { messages: turns.flatMap(turnMessages), status };
      if (status === 'error') result.error = 'The agent could not complete the last turn. You can send it again.';
      return result;
    },
    enqueue(agentId, text, requestId) {
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM turn WHERE agent_id=? AND request_id=?').get(agentId, requestId);
        if (existing) return { conflict: existing.text !== text, message: ownerMessage(existing) };
        mustAcceptWork(agentId);
        const turn = { id: randomUUID(), text, created_at: new Date().toISOString() };
        db.prepare(`
          INSERT INTO turn (id, agent_id, request_id, text, created_at, state) VALUES (?, ?, ?, ?, ?, 'queued')
        `).run(turn.id, agentId, requestId, text, turn.created_at);
        return { conflict: false, message: ownerMessage(turn) };
      });
    },
    claim(leaseMs) {
      return transaction(() => {
        const now = Date.now();
        // A crash or failed durable commit can repeat model inference. Bound that
        // cost across restarts; an explicit owner resubmission starts a new turn.
        db.prepare(`UPDATE turn SET state=CASE WHEN attempts>=3 THEN 'error' ELSE 'queued' END,
          token=NULL, lease_until=NULL WHERE state='working' AND lease_until<=?`).run(now);
        const turn = db.prepare(`
          SELECT t.*, g.id AS goal_id FROM turn t JOIN employment e ON e.agent_id=t.agent_id
          LEFT JOIN goal g ON g.turn_id=t.id WHERE t.state='queued' AND e.desired_state='active' AND NOT EXISTS (
            SELECT 1 FROM turn active WHERE active.agent_id=t.agent_id AND active.state='working'
          ) ORDER BY g.id IS NOT NULL, t.seq LIMIT 1
        `).get();
        if (!turn) return;
        const token = randomUUID();
        db.prepare("UPDATE turn SET state='working', attempts=attempts+1, token=?, lease_until=? WHERE id=?")
          .run(token, now + leaseMs, turn.id);
        // A second incoming message can be queued while the first turn is working.
        const history = db.prepare('SELECT * FROM turn WHERE agent_id=? AND seq<? ORDER BY seq')
          .all(turn.agent_id, turn.seq).flatMap(turnMessages);
        return { token, agent: getAgent(turn.agent_id), message: ownerMessage(turn), history, memories: getMemories(turn.agent_id),
          goalId: turn.goal_id, memoryRevision: memoryRevision(turn.agent_id) };
      });
    },
    complete(job, reply, memories, goalBlocked = false) {
      return transaction(() => {
        // Never publish a response or staged notes based on memory the owner changed mid-turn.
        if (memoryRevision(job.agent.id) !== job.memoryRevision) {
          releaseStatement.run(job.message.id, job.token);
          return false;
        }
        const updated = db.prepare(`
          UPDATE turn SET state='done', token=NULL, lease_until=NULL, reply_id=?, reply=?, completed_at=?
          WHERE id=? AND state='working' AND token=? AND lease_until>?
        `).run(randomUUID(), reply, new Date().toISOString(), job.message.id, job.token, Date.now());
        if (!updated.changes) return false;
        if (job.goalId) db.prepare('UPDATE goal SET checkpoint=?,steps=steps+1,blocked=?,updated_at=? WHERE id=?')
          .run(reply.slice(0, 2000), Number(goalBlocked), new Date().toISOString(), job.goalId);
        const insert = db.prepare(`
          INSERT INTO memory (id, agent_id, sourceMessageId, text, createdAt) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id,text) DO NOTHING
        `);
        for (const item of memories) insert.run(item.id, job.agent.id, job.message.id, item.text, item.createdAt);
        return true;
      });
    },
    fail(job) {
      return transaction(() => {
        const update = db.prepare("UPDATE turn SET state='error', token=NULL, lease_until=NULL WHERE id=? AND state='working' AND token=? AND lease_until>?")
          .run(job.message.id, job.token, Date.now());
        if (update.changes && job.goalId)
          db.prepare('UPDATE goal SET checkpoint=?, steps=steps+1, updated_at=? WHERE id=?')
            .run('The worker could not complete this step.', new Date().toISOString(), job.goalId);
        return Boolean(update.changes);
      });
    },
    release: job => releaseStatement.run(job.message.id, job.token),
    close: () => db.close()
  };
}
