// =============================================================
// 注文データの取り出し(管理者・会社の担当者・お店の画面で共通に使う)
// =============================================================

/**
 * 期間内の利用(お弁当・だるまランチ)を、会社・社員・お店の情報と一緒に取り出す。
 * companyId / shopId を指定すると、その会社・お店の分だけにしぼる。
 * kind を指定すると種類をしぼる('bento' / 'daruma_lunch')。指定しなければ両方。
 */
export async function ordersBetween(db, from, to, { companyId = null, shopId = null, kind = null } = {}) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.delivery_date, o.price, o.item_name, o.channel, o.updated_at, o.created_at, o.kind, o.tax_rate, o.points_used,
              o.user_id, u.login_id, u.name AS user_name, u.department,
              co.id AS company_id, co.code AS company_code, co.name AS company_name,
              s.id AS shop_id, s.name AS shop_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN companies co ON co.id = u.company_id
       JOIN shops s ON s.id = o.shop_id
       WHERE o.delivery_date BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR co.id = ?3) AND (?4 IS NULL OR s.id = ?4) AND (?5 IS NULL OR o.kind = ?5)
       ORDER BY o.delivery_date, co.id, u.department, u.login_id`
    )
    .bind(from, to, companyId, shopId, kind)
    .all();
  return results;
}

/** ある日のお弁当の注文と、お店ごと・お弁当ごとの集計(配達・印刷用なので、だるまランチは含めない) */
export async function dayOrders(db, date, { shopId = null } = {}) {
  const orders = await ordersBetween(db, date, date, { shopId, kind: 'bento' });
  const shops = new Map();
  for (const o of orders) {
    if (!shops.has(o.shop_id)) shops.set(o.shop_id, { shop_id: o.shop_id, shop_name: o.shop_name, count: 0, amount: 0, items: new Map() });
    const shop = shops.get(o.shop_id);
    shop.count++;
    shop.amount += o.price;
    if (!shop.items.has(o.item_name)) shop.items.set(o.item_name, { item_name: o.item_name, price: o.price, count: 0 });
    shop.items.get(o.item_name).count++;
  }
  return {
    total: orders.length,
    shops: [...shops.values()].map((x) => ({ ...x, items: [...x.items.values()] })),
    orders,
  };
}

/** ある日のだるまランチの利用(お店で食べた記録) */
export async function dayLunches(db, date, { shopId = null } = {}) {
  const rows = await ordersBetween(db, date, date, { shopId, kind: 'daruma_lunch' });
  return rows.map((o) => ({
    id: o.id,
    time: o.created_at, // 利用した時刻(UTC)
    company_name: o.company_name,
    department: o.department,
    user_name: o.user_name,
    shop_name: o.shop_name,
    item_name: o.item_name,
    price: o.price,
  }));
}
