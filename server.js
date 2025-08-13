import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { Pool } from 'pg';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APP_SECRET = process.env.APP_SECRET;
const ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || '*';
const MAKE_CONTACT_URL = process.env.MAKE_WEBHOOK_URL_CONTACT;
const SCHED_BASE = process.env.SCHEDULING_BASE_URL;
const SCHED_SECRET = process.env.SCHEDULING_TOKEN_SECRET;

app.use(helmet());
app.use(cors({ origin: ALLOW_ORIGIN === '*' ? true : [ALLOW_ORIGIN], credentials: true }));
app.use(express.json({ limit: '3mb' }));

function requireSecret(req, res, next){
  if(!APP_SECRET) return next();
  if(req.get('X-App-Secret') === APP_SECRET) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function now(){ return new Date().toISOString(); }

function generateSchedulingLink(patnum){
  const token = jwt.sign({ patnum, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 60*60*24*14 }, SCHED_SECRET);
  const url = new URL(SCHED_BASE);
  url.searchParams.set('pat', String(patnum));
  url.searchParams.set('t', token);
  return url.toString();
}

// --- health ---
app.get('/health', (req,res)=> res.json({ ok:true, ts: now() }));

// --- ingest ---
// Payload: [ { patnum, first_name, last_name, birthdate, phone, email, guarantor, last_txp_date, procedures:[{code,description,fee_cents,tooth,surface}], total_fee_cents?, plan_count? } ]
app.post('/ingest', requireSecret, async (req,res) => {
  const items = Array.isArray(req.body) ? req.body : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for(const x of items){
      const patnum = Number(x.patnum);
      const total = x.total_fee_cents ?? (x.procedures||[]).reduce((s,p)=> s + Number(p.fee_cents||0), 0);
      const planCount = x.plan_count ?? (x.procedures||[]).length;
      const codes = (x.procedures||[]).map(p=> p.code).slice(0,6);

      await client.query(
        `INSERT INTO patients (patnum, first_name, last_name, birthdate, phone, email, guarantor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (patnum) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
            birthdate=EXCLUDED.birthdate, phone=EXCLUDED.phone, email=EXCLUDED.email, guarantor=EXCLUDED.guarantor`,
        [patnum, x.first_name||null, x.last_name||null, x.birthdate||null, x.phone||null, x.email||null, x.guarantor||null]
      );

      // upsert opportunity by (patnum)
      const { rows } = await client.query(
        `SELECT id FROM opportunities WHERE patnum=$1 ORDER BY updated_at DESC LIMIT 1`, [patnum]
      );
      let oppId = rows[0]?.id;
      if(!oppId){
        const ins = await client.query(
          `INSERT INTO opportunities (patnum, total_fee_cents, plan_count, last_txp_date, top_codes)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [patnum, total, planCount, x.last_txp_date||null, codes]
        );
        oppId = ins.rows[0].id;
      } else {
        await client.query(
          `UPDATE opportunities SET total_fee_cents=$2, plan_count=$3, last_txp_date=$4, top_codes=$5, updated_at=now()
           WHERE id=$1`,
          [oppId, total, planCount, x.last_txp_date||null, codes]
        );
        await client.query('DELETE FROM opportunity_procedures WHERE opportunity_id=$1', [oppId]);
      }

      for(const p of (x.procedures||[])){
        await client.query(
          `INSERT INTO opportunity_procedures (opportunity_id, code, description, fee_cents, tooth, surface)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [oppId, p.code||null, p.description||null, Number(p.fee_cents||0), p.tooth||null, p.surface||null]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: items.length });
  } catch (e){
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'ingest_failed', detail: String(e?.message||e) });
  } finally { client.release(); }
});

// --- list opportunities ---
app.get('/opps', async (req,res) => {
  const minValue = Number(req.query.min_value || 0);
  const minDays = Number(req.query.min_days || 0);
  const q = (req.query.q||'').toString().trim();
  const limit = Math.min(Number(req.query.limit||100), 500);

  const params = [minValue, minDays];
  let where = `o.total_fee_cents >= $1 AND COALESCE((CURRENT_DATE - o.last_txp_date),0) >= $2`;
  if(q){
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (LOWER(p.first_name) LIKE $${params.length} OR LOWER(p.last_name) LIKE $${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT o.id, o.patnum, p.first_name, p.last_name, p.phone, p.email,
            o.total_fee_cents, o.plan_count, o.last_txp_date,
            COALESCE((CURRENT_DATE - o.last_txp_date),0) AS days_since_plan,
            o.status, o.top_codes
     FROM opportunities o
     JOIN patients p ON p.patnum=o.patnum
     WHERE ${where}
     ORDER BY (o.total_fee_cents*0.6 + COALESCE((CURRENT_DATE - o.last_txp_date),0)*100 + CASE WHEN p.phone IS NOT NULL THEN 10000 ELSE 0 END) DESC
     LIMIT ${limit}`,
    params
  );
  res.json(rows);
});

// --- get single opp detail ---
app.get('/opps/:id', async (req,res)=>{
  const id = req.params.id;
  const { rows: opps } = await pool.query(
    `SELECT o.*, p.first_name, p.last_name, p.phone, p.email FROM opportunities o JOIN patients p ON p.patnum=o.patnum WHERE o.id=$1`, [id]
  );
  if(!opps[0]) return res.status(404).json({ error: 'not_found' });
  const { rows: procs } = await pool.query('SELECT * FROM opportunity_procedures WHERE opportunity_id=$1 ORDER BY fee_cents DESC', [id]);
  res.json({ ...opps[0], procedures: procs, scheduling_link: generateSchedulingLink(opps[0].patnum) });
});

// --- update status ---
app.post('/opps/:id/status', async (req,res)=>{
  const id = req.params.id; const { status } = req.body||{};
  await pool.query('UPDATE opportunities SET status=$2, updated_at=now() WHERE id=$1', [id, status||'new']);
  res.json({ ok: true });
});

// --- contact trigger (server → Make) ---
app.post('/opps/:id/contact', async (req,res)=>{
  const id = req.params.id; const { channel, templateKey } = req.body||{};
  const { rows: opps } = await pool.query(
    `SELECT o.*, p.first_name, p.last_name, p.phone, p.email FROM opportunities o JOIN patients p ON p.patnum=o.patnum WHERE o.id=$1`, [id]
  );
  const opp = opps[0];
  if(!opp) return res.status(404).json({ error: 'not_found' });
  const scheduling_link = generateSchedulingLink(opp.patnum);

  const payload = {
    id, channel, templateKey,
    patient: {
      patnum: opp.patnum, first_name: opp.first_name, last_name: opp.last_name,
      phone: opp.phone, email: opp.email
    },
    opportunity: {
      total_fee_cents: opp.total_fee_cents,
      last_txp_date: opp.last_txp_date,
      codes: opp.top_codes
    },
    scheduling_link
  };

  const r = await fetch(MAKE_CONTACT_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Secret': APP_SECRET },
    body: JSON.stringify(payload)
  });

  const body = await r.text();
  await pool.query('UPDATE opportunities SET status=$2, last_contacted_at=now(), updated_at=now() WHERE id=$1', [id, 'contacted']);
  await pool.query('INSERT INTO contact_logs (opportunity_id, channel, template_key, result, vendor_msg_id, payload) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, channel, templateKey, r.ok ? 'sent':'failed', null, payload]);

  res.json({ ok: r.ok, make_response: body });
});

// --- Make callback (delivery/reply) ---
app.post('/webhooks/make/outcome', requireSecret, async (req,res) => {
  const { opportunity_id, result, vendor_msg_id, status } = req.body||{};
  if(opportunity_id){
    await pool.query('INSERT INTO contact_logs (opportunity_id, channel, template_key, result, vendor_msg_id, payload) VALUES ($1,$2,$3,$4,$5,$6)',
      [opportunity_id, req.body.channel||null, req.body.templateKey||null, result||null, vendor_msg_id||null, req.body]);
    if(status){
      await pool.query('UPDATE opportunities SET status=$2, updated_at=now() WHERE id=$1', [opportunity_id, status]);
    }
  }
  res.json({ ok: true });
});

const port = process.env.PORT || 8080;
app.listen(port, ()=> console.log(`Treatment Finder API listening on :${port}`));