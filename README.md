# FARE BOARD — 地域×航空連合 探索ダッシュボード

行き先を決め打ちせず、**「地域」×「航空連合」の範囲内でいま一番安い行き先はどこか**を
自動で発見し、GitHub Pages上に一覧表示するツールです。

## できること

- 出発地(例: TYO)から、指定した地域(大陸/サブリージョン/独自グループ)かつ
  指定した航空連合(oneworld / SkyTeam / Star Alliance / その他)に該当する行き先だけを対象に、
  最安値ランキングを自動生成
- 6時間ごとに自動実行、結果はダッシュボードに反映
- 特定の航空連合に属する海外の航空会社ごとに、その便を使った場合どの地域が一番安いかも発見(`carrierScopes`)

## できないこと(制限)

- 自動購入はしません
- 価格はキャッシュベースなので、リアルタイムの空席・確定価格ではありません
- 予約クラス(RBD)の確認はできません。条件に合う行き先が見つかったら航空会社サイトで最終確認してください

## データソース

- **運賃**: Travelpayouts Data API (`v1/prices/cheap`)
- **航空連合の対応表**: Travelpayouts `data/en/airlines_alliances.json`(毎回取得、自動追従)
- **都市→国**: Travelpayouts `data/en/cities.json`
- **国→大陸/サブリージョン**: `data/geo.json`(npmの`world-countries`から生成した静的データ)

## セットアップ済みの内容

- `config.json`: 条件設定(地域・連合・出発地など)
- `scripts/check-fares.mjs`: メインスクリプト
- `.github/workflows/fare-check.yml`: 6時間ごとの自動実行設定
- `index.html`: ダッシュボード
- `data/geo.json`: 国→地域データ

## 残りの手順

1. Settings → Secrets and variables → Actions → `TRAVELPAYOUTS_TOKEN` を登録
2. Settings → Pages → Source を `main` / `/ (root)` に設定
3. Actions タブ → 「Fare Check」→ Run workflow で動作確認
