-- ロジ弁 データベースの形(テーブル定義)
-- 注意:このファイルを実行すると、データはすべて消えて作り直されます。

DROP TABLE IF EXISTS closed_days;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS menu_items;
DROP TABLE IF EXISTS shops;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS settings;

-- 契約している会社
CREATE TABLE companies (
  id   INTEGER PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE,    -- ログイン時に入力する会社コード
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 -- 0=契約終了(社員はログインできなくなる)
);

-- お弁当屋さん・飲食店
CREATE TABLE shops (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- お店ごとのメニュー(値段はお店が自由に決める・税込み)
CREATE TABLE menu_items (
  id          INTEGER PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops(id),
  name        TEXT NOT NULL,
  description TEXT,
  price       INTEGER NOT NULL,    -- 税込み価格(円)
  active      INTEGER NOT NULL DEFAULT 1
);

-- ログインする人(社員/会社の担当者/お店/管理者)
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('employee', 'company', 'shop', 'admin')),
  company_id    INTEGER REFERENCES companies(id),
  shop_id       INTEGER REFERENCES shops(id),
  login_id      TEXT NOT NULL,     -- 社員番号 など
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  department    TEXT,              -- 部署
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX users_login ON users (role, COALESCE(company_id, 0), login_id);

-- 注文
-- 値段・商品名は注文した時点のものを記録(あとでメニューの値段が変わっても過去の注文は変わらない)
-- channel:注文経路(web / 将来 line)
-- kind:種類(bento=お弁当 / 将来 daruma_lunch=だるまランチ)
CREATE TABLE orders (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  delivery_date TEXT NOT NULL,     -- お届け日 YYYY-MM-DD
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id),
  shop_id       INTEGER NOT NULL REFERENCES shops(id),
  item_name     TEXT NOT NULL,
  price         INTEGER NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'web',
  kind          TEXT NOT NULL DEFAULT 'bento',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, delivery_date, kind)
);
CREATE INDEX orders_date ON orders (delivery_date);

-- ログイン状態
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- 管理者が画面から変えられる設定
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 休業日(土日・祝日は自動でお休みなので、ここには入れなくてよい)
--   shop_id が空 = 全体の休業日(年末年始など。注文を受け付けない)
--   shop_id あり = そのお店だけの休業日(そのお店のお弁当が選べなくなる)
CREATE TABLE closed_days (
  id      INTEGER PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  date    TEXT NOT NULL,
  note    TEXT
);
CREATE UNIQUE INDEX closed_days_unique ON closed_days (COALESCE(shop_id, 0), date);
