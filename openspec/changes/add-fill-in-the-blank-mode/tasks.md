## 1. データベース・マイグレーション

- [ ] 1.1 `init.sql` の `scores` テーブルに `mode VARCHAR(16) NOT NULL DEFAULT 'normal'` を追加（新規作成定義）
- [ ] 1.2 既存デプロイ向けマイグレーション `ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'normal'` を追記
- [ ] 1.3 ランキング用インデックスをモード対応に（`idx_scores_ranking` を `(mode, score DESC, stage DESC)` に変更／追加）

## 2. バックエンドAPI（Hono）のモード対応

- [ ] 2.1 `Question` 型に `blank: 0|1|2`、`PlayToken` / `CarryToken` に `mode: 'normal'|'blank'` を追加
- [ ] 2.2 `genQuestion` を拡張し、虫食いモードでは `□` 位置（1項目/2項目）をランダムに付与（足し算 `a+b` 生成ロジックは流用）
- [ ] 2.3 `publicQuestions` をモード／`blank` で出し分け、隠す数を含めない（`blank=0`→`{num1,num2}`、`blank=1`→`{num2,sum}`、`blank=2`→`{num1,sum}` ＋ `blank`）
- [ ] 2.4 `POST /api/stages/start` で `body.mode`／`carry_token` のモードを受理（未指定・不正は `normal` フォールバック）し、トークンへ格納
- [ ] 2.5 `POST /api/stages/more` でトークン内モードを維持して追加生成
- [ ] 2.6 `verifyAndScore` の検証プールキーを `${num1}_${num2}_${blank}` に拡張し、正誤判定をモード・`□` 位置対応に（スコア計算式・ゲージ加算式は不変）
- [ ] 2.7 クリア時のキャリートークンにモードを引き継ぐ
- [ ] 2.8 `POST /api/scores/submit` でトークン内モードを `scores.mode` に保存（クライアント申告は信用しない）
- [ ] 2.9 `GET /api/scores` に `?mode=normal|blank`（既定 `normal`）フィルタを追加
- [ ] 2.10 後方互換: `blank` 欠落は `0`、`mode` 欠落は `normal` として扱う

## 3. フロントエンド: スタート画面（2ボタン）

- [ ] 3.1 `index.astro` の単一開始ボタンを「通常モード」「虫食いモード」の2ボタンに変更
- [ ] 3.2 `startNewGame(stage, mode)` でモードを受け取り、`/api/stages/start` に `mode` を送信
- [ ] 3.3 ルール説明文に虫食いモードの説明を追記

## 4. フロントエンド: ゲームプレイのモード対応（game.js / game.astro）

- [ ] 4.1 `gameStore` にモード状態を保持し、`more` 取得・登録・ランキング遷移まで引き継ぐ
- [ ] 4.2 `game.astro` の問題表示を `blank` で出し分け（`□ + b = c` / `a + □ = c` / 通常）し、`□` を強調表示
- [ ] 4.3 回答判定（`submit` 内）をモード対応に（虫食いは隠された項を正解とし、`sum` と見える項から復元）
- [ ] 4.4 `answersLog` に `blank` を含め、虫食いでも `num1`/`num2` を復元して送信
- [ ] 4.5 必殺技ゲージ加算が両モードで `10 + ((num1+num2)%16)` のまま一致することを確認

## 5. フロントエンド: ランキング画面のモード別表示

- [ ] 5.1 `ranking.astro` にモード切替（タブ／クエリ）を実装し、選択モードのトップ10を表示
- [ ] 5.2 結果遷移（`?r=<score_id>`）時に当該スコアのモードで順位＋前後表示を行う
- [ ] 5.3 ゲーム終了→登録→ランキング遷移時にモードを受け渡す

## 6. 動作確認

- [ ] 6.1 Docker コンテナ内で両モードのプレイ・クリア・ゲームオーバーを確認
- [ ] 6.2 虫食いモードで隠す数がネットワークペイロードに漏れていないことを確認
- [ ] 6.3 改ざん（不正な `(num1,num2,blank)` 組）が検証で拒否されることを確認
- [ ] 6.4 ランキングがモード別に分離表示され、二重登録防止が機能することを確認
- [ ] 6.5 既存の通常モードのスコア・挙動が後方互換であることを確認
