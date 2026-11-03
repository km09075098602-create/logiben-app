// =============================================================
// 登録画面のAPI(管理者だけが使える)
//   お店 / メニュー / 会社 / 社員 の 一覧・追加・変更
// 「削除」はせず「停止(active=0)」にします。過去の注文や請求の記録を残すためです。
// =============================================================
import { hashPassword } from './password.js';

/** 入力が正しくないときに投げるエラー(画面にそのまま表示される) */
class InputError extends Error {}

/** 文字の入力チェック */
function text(value, label, { required = true, max = 50 } = {}) {
  const v = String(value ?? '').trim();
  if (required && !v) throw new InputError(`${label}を入力してください`);
  if (v.length > max) throw new InputError(`${label}は${max}文字以内で入力してください`);
  return v;
}

/** 金額などの整数チェック */
function int(value, label, { min = 0, max = 100000 } = {}) {
  const v = Number(value);
  if (!Number.isInteger(v) || v < min || v > max) throw new InputError(`${label}は${min}〜${max}の整数で入力してください`);
  return v;
}

/** 社員番号・会社コード(英数字と - _ のみ) */
function code(value, label) {
  const v = text(value, label, { max: 20 });
  if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new InputError(`${label}は半角英数字で入力してください`);
  return v;
}

const flag = (v) => (v === false || v === 0 || v === '0' ? 0 : 1);

/** 配りやすい初期パスワード(紛らわしい 0/O/1/l/I は使わない) */
export function generatePassword(length = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const rnd = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(rnd, (n) => chars[n % chars.length]).join('');
}

/** 社員1人分の入力チェック */
function checkEmployee(row) {
  return {
    login_id: code(row.login_id, '社員番号'),
    name: text(row.name, '名前'),
    department: text(row.department, '部署', { required: false }),
  };
}

export function registerMasterRoutes(app) {
  // 入力エラーと「同じものがすでにある」エラーを、わかりやすい言葉にする
  app.onError((err, c) => {
    if (err instanceof InputError) return c.json({ error: err.message }, 400);
    if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'すでに同じもの(コード・番号)が登録されています' }, 400);
    console.error(err);
    return c.json({ error: 'サーバーでエラーが起きました' }, 500);
  });

  const body = (c) => c.req.json().catch(() => ({}));
  const id = (c) => int(c.req.param('id'), 'ID', { min: 1, max: Number.MAX_SAFE_INTEGER });

  // ---------- お店とメニュー ----------

  app.get('/api/admin/shops', async (c) => {
    const db = c.env.DB;
    const { results: shops } = await db.prepare('SELECT id, name, active FROM shops ORDER BY active DESC, id').all();
    const { results: items } = await db
      .prepare('SELECT id, shop_id, name, description, price, active FROM menu_items ORDER BY active DESC, price, id')
      .all();
    return c.json(shops.map((s) => ({ ...s, items: items.filter((i) => i.shop_id === s.id) })));
  });

  app.post('/api/admin/shops', async (c) => {
    const b = await body(c);
    const r = await c.env.DB.prepare('INSERT INTO shops (name) VALUES (?)').bind(text(b.name, 'お店の名前')).run();
    return c.json({ id: r.meta.last_row_id });
  });

  app.put('/api/admin/shops/:id', async (c) => {
    const b = await body(c);
    await c.env.DB.prepare('UPDATE shops SET name = ?, active = ? WHERE id = ?')
      .bind(text(b.name, 'お店の名前'), flag(b.active), id(c))
      .run();
    return c.json({ ok: true });
  });

  const menuFields = (b) => [
    text(b.name, 'お弁当の名前'),
    text(b.description, '説明', { required: false, max: 100 }),
    int(b.price, '値段(税込み)', { min: 1, max: 100000 }),
  ];

  app.post('/api/admin/menu', async (c) => {
    const b = await body(c);
    const shopId = int(b.shop_id, 'お店', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const r = await c.env.DB.prepare('INSERT INTO menu_items (shop_id, name, description, price) VALUES (?, ?, ?, ?)')
      .bind(shopId, ...menuFields(b))
      .run();
    return c.json({ id: r.meta.last_row_id });
  });

  // 値段を変えても、すでに入っている注文の値段は変わらない(注文時の値段を記録しているため)
  app.put('/api/admin/menu/:id', async (c) => {
    const b = await body(c);
    await c.env.DB.prepare('UPDATE menu_items SET name = ?, description = ?, price = ?, active = ? WHERE id = ?')
      .bind(...menuFields(b), flag(b.active), id(c))
      .run();
    return c.json({ ok: true });
  });

  // ---------- 会社 ----------

  app.get('/api/admin/companies', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT c.id, c.code, c.name, c.active,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'employee' AND u.active = 1) AS employee_count
       FROM companies c ORDER BY c.active DESC, c.id`
    ).all();
    return c.json(results);
  });

  app.post('/api/admin/companies', async (c) => {
    const b = await body(c);
    const r = await c.env.DB.prepare('INSERT INTO companies (code, name) VALUES (?, ?)')
      .bind(code(b.code, '会社コード').toUpperCase(), text(b.name, '会社名'))
      .run();
    return c.json({ id: r.meta.last_row_id });
  });

  app.put('/api/admin/companies/:id', async (c) => {
    const b = await body(c);
    await c.env.DB.prepare('UPDATE companies SET code = ?, name = ?, active = ? WHERE id = ?')
      .bind(code(b.code, '会社コード').toUpperCase(), text(b.name, '会社名'), flag(b.active), id(c))
      .run();
    return c.json({ ok: true });
  });

  // ---------- 社員 ----------

  app.get('/api/admin/employees', async (c) => {
    const companyId = int(c.req.query('company_id'), '会社', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const { results } = await c.env.DB.prepare(
      `SELECT id, login_id, name, department, active FROM users
       WHERE role = 'employee' AND company_id = ? ORDER BY active DESC, department, login_id`
    )
      .bind(companyId)
      .all();
    return c.json(results);
  });

  /** 社員を1人追加(初期パスワードを自動で作って返す) */
  app.post('/api/admin/employees', async (c) => {
    const b = await body(c);
    const companyId = int(b.company_id, '会社', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const e = checkEmployee(b);
    const password = generatePassword();
    await c.env.DB.prepare(
      `INSERT INTO users (role, company_id, login_id, password_hash, name, department) VALUES ('employee', ?, ?, ?, ?, ?)`
    )
      .bind(companyId, e.login_id, await hashPassword(password), e.name, e.department)
      .run();
    return c.json({ ...e, password });
  });

  /**
   * 社員をまとめて追加(CSV)。
   * check_only=true なら、登録はせずに入力チェックだけ行う(先に全体を確かめるため)。
   * パスワードの暗号化は時間がかかるので、画面側から20人ずつ送ってもらう。
   */
  app.post('/api/admin/employees/bulk', async (c) => {
    const b = await body(c);
    const db = c.env.DB;
    const companyId = int(b.company_id, '会社', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) throw new InputError('登録する社員がいません');
    if (rows.length > 1000) throw new InputError('一度に登録できるのは1,000人までです');

    const { results: existing } = await db
      .prepare(`SELECT login_id FROM users WHERE role = 'employee' AND company_id = ?`)
      .bind(companyId)
      .all();
    const taken = new Set(existing.map((r) => r.login_id));
    const errors = [];
    const valid = [];
    for (const row of rows) {
      try {
        const e = checkEmployee(row);
        if (taken.has(e.login_id)) throw new InputError(`社員番号 ${e.login_id} はすでに登録されています`);
        taken.add(e.login_id);
        valid.push(e);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        errors.push(`${row.line ?? ''}行目:${err.message}`);
      }
    }
    if (errors.length || b.check_only) return c.json({ ok: !errors.length, errors, count: valid.length });

    const created = [];
    const stmts = [];
    for (const e of valid) {
      const password = generatePassword();
      stmts.push(
        db
          .prepare(`INSERT INTO users (role, company_id, login_id, password_hash, name, department) VALUES ('employee', ?, ?, ?, ?, ?)`)
          .bind(companyId, e.login_id, await hashPassword(password), e.name, e.department)
      );
      created.push({ ...e, password });
    }
    await db.batch(stmts);
    return c.json({ ok: true, errors: [], created });
  });

  /** 社員の変更(名前・部署・停止)。停止すると、明日以降の注文は取り消される */
  app.put('/api/admin/employees/:id', async (c) => {
    const b = await body(c);
    const db = c.env.DB;
    const userId = id(c);
    const e = checkEmployee(b);
    const active = flag(b.active);
    const stmts = [
      db
        .prepare(`UPDATE users SET login_id = ?, name = ?, department = ?, active = ? WHERE id = ? AND role = 'employee'`)
        .bind(e.login_id, e.name, e.department, active, userId),
    ];
    if (!active) {
      stmts.push(db.prepare(`DELETE FROM orders WHERE user_id = ? AND delivery_date > date('now', '+9 hours')`).bind(userId));
      stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));
    }
    await db.batch(stmts);
    return c.json({ ok: true });
  });

  /** パスワードを作り直す(社員が忘れたとき) */
  app.post('/api/admin/employees/:id/reset-password', async (c) => {
    const db = c.env.DB;
    const userId = id(c);
    const password = generatePassword();
    const r = await db
      .prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND role = 'employee'`)
      .bind(await hashPassword(password), userId)
      .run();
    if (!r.meta.changes) throw new InputError('社員が見つかりません');
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    return c.json({ password });
  });
}
