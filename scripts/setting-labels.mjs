// 管理画面の「設定」に表示する名前(お試しデータと本番データで共通)
export const SETTING_LABELS = {
  deadline_days_before: '締め切り日(0=当日 / 1=前日)',
  deadline_time: '締め切り時刻(日本時間)',
  company_cap_excl: '会社負担の上限(1人・月・税抜き 円)',
  tax_rate_percent: 'お弁当の消費税率(%)',
  eatin_tax_rate_percent: 'だるまランチ(お店で食べる)の消費税率(%)',
  warn_percent: '上限の何%で社員に知らせるか(%)',
  company_share_percent: '会社が負担する割合(%)',
  service_fee: 'サービス利用料(1食 円)',
  agency_fee_percent: '営業代行料(%)',
  order_days_ahead: '何日先まで注文できるか(日)',
  shop_period_anchor: 'お店への支払いの区切りの起点日(この日から2週間ずつ)',
  points_enabled: 'ポイント還元(1=使う / 0=使わない)',
  point_per_use: '1回の利用でもらえるポイント',
  point_grant_delay_months: 'ポイントをもらえる時期(利用した月の何か月後の給料日の翌日か。1=翌月)',
  point_expiry_months: 'ポイントの有効期限(か月)',
  point_max_per_order: '1回の注文で使えるポイントの上限',
};
