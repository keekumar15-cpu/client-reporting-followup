const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');

const pool = require('./db');
const {
  STAGES,
  nextStage,
  prevStage,
  formatMoney,
  formatDateLong,
  formatMonth,
  dueLabel,
  ADVANCE_LABEL,
} = require('./helpers');

const app = express();

const PORT = process.env.PORT || 4001;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;
const OWNER_ID = process.env.OWNER_ID || '00000000-0000-0000-0000-000000000001';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';

if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('Missing ADMIN_PASSWORD_HASH or SESSION_SECRET environment variable.');
  process.exit(1);
}

// Behind Traefik (TLS terminated upstream) — required or the secure
// session cookie is silently never set. See deployment notes.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
}

// ---------- auth ----------

app.get('/', (req, res) => {
  res.redirect(req.session && req.session.authed ? '/board' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/board');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const okUser = username === ADMIN_USERNAME;
    const okPass = okUser && (await bcrypt.compare(password || '', ADMIN_PASSWORD_HASH));
    if (!okUser || !okPass) {
      return res.render('login', { error: 'Incorrect username or password.' });
    }
    req.session.authed = true;
    req.session.username = username;
    req.session.save(() => res.redirect('/board'));
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Try again.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- board ----------

app.get('/board', requireAuth, async (req, res) => {
  try {
    const rowsResult = await pool.query(
      `select * from report_followups_board
       where owner_id = $1
       order by is_overdue desc, chase_date asc nulls last,
                report_month desc, client_name asc
       limit 500`,
      [OWNER_ID]
    );
    const moneyResult = await pool.query(
      `select * from report_followups_money where owner_id = $1`,
      [OWNER_ID]
    );

    const rows = rowsResult.rows.map((r) => ({
      ...r,
      dueLabel: dueLabel(r),
      advanceLabel: ADVANCE_LABEL[r.stage] || null,
      canUndo: r.stage !== 'Due',
      monthLabel: formatMonth(r.report_month),
      feeLabel: formatMoney(r.fee_minor, r.currency),
    }));

    const money = moneyResult.rows[0] || null;
    const overdueCount = rows.filter((r) => r.is_overdue).length;

    res.render('board', {
      username: req.session.username,
      rows,
      hasRows: rows.length > 0,
      money: money
        ? {
            notYetSent: formatMoney(money.not_sent_minor, DEFAULT_CURRENCY),
            sentNotPaid: formatMoney(money.sent_unpaid_minor, DEFAULT_CURRENCY),
          }
        : null,
      rowCount: rows.length,
      overdueCount,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('The call to the database failed. Check server logs.');
  }
});

// ---------- add client ----------

app.post('/rows', requireAuth, async (req, res) => {
  const { client_name, report_month, fee, report_due_date, payment_due_date } = req.body;

  const errors = [];
  const name = (client_name || '').trim();
  if (!name || name.length > 120) errors.push('Client name is required.');
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(report_month || '')) {
    errors.push('Report month must look like 2026-08.');
  }
  const feeNumber = Number(fee);
  if (!fee || Number.isNaN(feeNumber) || feeNumber <= 0) {
    errors.push('Fee must be greater than zero.');
  }
  if (!report_due_date) errors.push('Report due date is required.');

  if (errors.length) {
    return res.redirect(`/board?error=${encodeURIComponent(errors.join(' '))}`);
  }

  const feeMinor = Math.round(feeNumber * 100);

  try {
    await pool.query(
      `insert into report_followups
         (owner_id, client_name, report_month, fee_minor, currency, report_due_date, payment_due_date)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        OWNER_ID,
        name,
        report_month,
        feeMinor,
        DEFAULT_CURRENCY,
        report_due_date,
        payment_due_date || null,
      ]
    );
    res.redirect('/board');
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect(
        `/board?error=${encodeURIComponent('That client already has a row for this month.')}`
      );
    }
    console.error(err);
    res.redirect(`/board?error=${encodeURIComponent('Could not save the new row.')}`);
  }
});

// ---------- outcome actions ----------

app.post('/rows/:id/advance', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'select stage from report_followups where id = $1 and owner_id = $2',
      [req.params.id, OWNER_ID]
    );
    if (!rows.length) return res.redirect('/board');
    const target = nextStage(rows[0].stage);
    if (!target) return res.redirect('/board');

    await pool.query(
      'update report_followups set stage = $1 where id = $2 and owner_id = $3',
      [target, req.params.id, OWNER_ID]
    );
    res.redirect('/board');
  } catch (err) {
    console.error(err);
    res.redirect(`/board?error=${encodeURIComponent(err.message || 'Could not update stage.')}`);
  }
});

app.post('/rows/:id/undo', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'select stage from report_followups where id = $1 and owner_id = $2',
      [req.params.id, OWNER_ID]
    );
    if (!rows.length) return res.redirect('/board');
    const target = prevStage(rows[0].stage);
    if (!target) return res.redirect('/board');

    await pool.query(
      'update report_followups set stage = $1 where id = $2 and owner_id = $3',
      [target, req.params.id, OWNER_ID]
    );
    res.redirect('/board');
  } catch (err) {
    console.error(err);
    res.redirect(`/board?error=${encodeURIComponent(err.message || 'Could not undo.')}`);
  }
});

app.listen(PORT, () => {
  console.log(`Client Reporting Follow-up Board listening on :${PORT}`);
});
