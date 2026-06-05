## 0. テスト基盤の構築（TDDの前提）

- [x] 0.1 `vitest` を devDependencies に追加し、`test`（単発）・`test:watch` スクリプトを定義（コンテナ内で実行）
- [x] 0.2 生成・検証ロジックを `src/pages/api/[...path].ts` から純関数モジュール `src/lib/game-logic.ts` へ切り出す（`genQuestion`/`genNoCarry`/`genBatch`/`publicQuestions`/`verifyAndScore` ＋型）。ルートは re-import に変更（**挙動不変のリファクタ**）
- [x] 0.3 既存挙動の回帰テストを先に固定（通常モードの `genQuestion` 範囲・`publicQuestions` が `answer` を含まない・`verifyAndScore` のスコア計算と改ざん検出）→ 全green を確認

## 1. 問題生成（虫食い）— ロジックTDD

- [x] 1.1 [RED] `genQuestion(stage, 'blank')` が `blank ∈ {1,2}` を返し、和（`c`）は隠さないことを検証するテスト
- [x] 1.2 [GREEN] `Question` に `blank: 0|1|2` を追加し、`genQuestion` をモード対応に実装（`a+b` 生成ロジックは流用、`□` 位置をランダム付与）
- [x] 1.3 [RED] `publicQuestions` が虫食いで隠した数を含めないテスト（`blank=0`→`{num1,num2}` / `blank=1`→`{num2,sum,blank}` / `blank=2`→`{num1,sum,blank}`）
- [x] 1.4 [GREEN] `publicQuestions` をモード・`blank` 対応に実装

## 2. 回答判定・セッション検証（虫食い）— ロジックTDD

- [x] 2.1 [RED] 検証プールキーを `${num1}_${num2}_${blank}` に拡張し、生成された組のみ受理するテスト
- [x] 2.2 [RED] 虫食いの正誤が「隠された項」基準（`blank=1`→被加数 `num1`、`blank=2`→加数 `num2`）で判定されるテスト
- [x] 2.3 [RED] スコア・ダメージ・タイムボーナス・必殺技ゲージ加算（`10 + ((num1+num2)%16)`）が両モードで同一式であることのテスト
- [x] 2.4 [GREEN] `verifyAndScore` をモード・`□` 位置対応に実装（**計算式は不変**）
- [x] 2.5 [RED→GREEN] 改ざん（生成されていない `(num1,num2,blank)` 組）が検証失敗になるテスト

## 3. トークン型とモード正規化 — ロジックTDD（純ロジックのみ。エンドポイント結線は Section 5）

- [x] 3.1 [GREEN] `PlayToken`/`CarryToken` 型に `mode?: GameMode` を追加（`genBatch` は Section 1 で既に mode 対応済み）
- [x] 3.2 [RED→GREEN] トークンの `mode` が encrypt→decrypt のラウンドトリップで保持されることのテスト（両トークン型）
- [x] 3.3 [RED→GREEN] 後方互換: トークンの `mode` 欠落/不正は `normalizeMode` で `normal` に正規化されることのテスト（`blank` 欠落=`0` は Section 2 で固定済み）

## 4. データベース・マイグレーション（DBはユニット困難 → 手動/結合で確認）

- [x] 4.1 `init.sql` の `scores` テーブルに `mode VARCHAR(16) NOT NULL DEFAULT 'normal'` を追加（新規作成定義）
- [x] 4.2 既存デプロイ向けマイグレーション `ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'normal'` を追記
- [x] 4.3 ランキング用インデックスをモード対応に（`idx_scores_ranking` を `(mode, score DESC, stage DESC)` に変更／追加）

## 5. API エンドポイントの結線（Hono）— モードの start→more→clear→carry 受け渡しはここで実装

- [x] 5.1 `POST /api/stages/start` で `body.mode`／`carry_token` のモードを受理（未指定・不正は `normal` フォールバック）し、トークンへ格納
- [x] 5.2 `POST /api/stages/more` でトークン内モードを維持して追加生成
- [x] 5.3 クリア時のキャリートークンにモードを引き継ぐ
- [x] 5.4 `POST /api/scores/submit` でトークン内モードを `scores.mode` に保存（クライアント申告は信用しない）
- [x] 5.5 `GET /api/scores` に `?mode=normal|blank`（既定 `normal`）フィルタを追加
- [x] 5.6 可能なら `app.request()` でエンドポイントの結合テストを追加（start→more→submit のモード貫通）

## 6. フロントエンド: スタート画面（2ボタン）

- [x] 6.1 `index.astro` の単一開始ボタンを「通常モード」「虫食いモード」の2ボタンに変更
- [x] 6.2 `startNewGame(stage, mode)` でモードを受け取り、`/api/stages/start` に `mode` を送信
- [x] 6.3 ルール説明文に虫食いモードの説明を追記

## 7. フロントエンド: ゲームプレイのモード対応（game.js / game.astro）

- [x] 7.1 `gameStore` にモード状態を保持し、`more` 取得・登録・ランキング遷移まで引き継ぐ
- [x] 7.2 `game.astro` の問題表示を `blank` で出し分け（`□ + b = c` / `a + □ = c` / 通常）し、`□` を強調表示
- [x] 7.3 回答判定（`submit` 内）をモード対応に（虫食いは隠された項を正解とし、`sum` と見える項から復元）
- [x] 7.4 `answersLog` に `blank` を含め、虫食いでも `num1`/`num2` を復元して送信
- [x] 7.5 必殺技ゲージ加算が両モードで `10 + ((num1+num2)%16)` のまま一致することを確認

## 8. フロントエンド: ランキング画面のモード別表示

- [x] 8.1 `ranking.astro` にモード切替（タブ／クエリ）を実装し、選択モードのトップ10を表示
- [x] 8.2 結果遷移（`?r=<score_id>`）時に当該スコアのモードで順位＋前後表示を行う
- [x] 8.3 ゲーム終了→登録→ランキング遷移時にモードを受け渡す

## 9. 動作確認（E2E／手動）

- [ ] 9.1 Docker コンテナ内で両モードのプレイ・クリア・ゲームオーバーを確認
- [ ] 9.2 虫食いモードで隠す数がネットワークペイロードに漏れていないことを確認
- [ ] 9.3 改ざん（不正な `(num1,num2,blank)` 組）が検証で拒否されることを確認
- [ ] 9.4 ランキングがモード別に分離表示され、二重登録防止が機能することを確認
- [ ] 9.5 既存の通常モードのスコア・挙動が後方互換であることを確認
