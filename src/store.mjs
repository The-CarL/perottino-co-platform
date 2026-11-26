import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function ownerMessage(turn) {
  return { id: turn.id, author: 'owner', text: turn.text, createdAt: turn.created_at };
}

function turnMessages(turn) {
  const messages = [ownerMessage(turn)];
  if (turn.reply_id) {
    messages.push({ id: turn.reply_id, author: 'agent', text: turn.reply, createdAt: turn.completed_at });
  }
  return messages;
}

export function createStore(dataDir) {
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
    if (!db.prepare('PRAGMA table_info(turn)').all().some(column => column.name === 'attempts'))
      db.exec('ALTER TABLE turn ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  });

  const getAgent = id => db.prepare('SELECT id, name, handle, role FROM agent WHERE id=?').get(id);
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
          SELECT * FROM turn t WHERE t.state='queued' AND NOT EXISTS (
            SELECT 1 FROM turn active WHERE active.agent_id=t.agent_id AND active.state='working'
          ) ORDER BY seq LIMIT 1
        `).get();
        if (!turn) return;
        const token = randomUUID();
        db.prepare("UPDATE turn SET state='working', attempts=attempts+1, token=?, lease_until=? WHERE id=?")
          .run(token, now + leaseMs, turn.id);
        // A second incoming message can be queued while the first turn is working.
        const history = db.prepare('SELECT * FROM turn WHERE agent_id=? AND seq<? ORDER BY seq')
          .all(turn.agent_id, turn.seq).flatMap(turnMessages);
        return { token, agent: getAgent(turn.agent_id), message: ownerMessage(turn), history, memories: getMemories(turn.agent_id), memoryRevision: memoryRevision(turn.agent_id) };
      });
    },
    complete(job, reply, memories) {
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
        const insert = db.prepare(`
          INSERT INTO memory (id, agent_id, sourceMessageId, text, createdAt) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id,text) DO NOTHING
        `);
        for (const item of memories) insert.run(item.id, job.agent.id, job.message.id, item.text, item.createdAt);
        return true;
      });
    },
    fail(job) {
      db.prepare("UPDATE turn SET state='error', token=NULL, lease_until=NULL WHERE id=? AND state='working' AND token=? AND lease_until>?")
        .run(job.message.id, job.token, Date.now());
    },
    release: job => releaseStatement.run(job.message.id, job.token),
    close: () => db.close()
  };
}
