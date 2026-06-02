# CLAUDE.md

## 開発コマンドの実行ルール

**テスト・開発に使用するコマンドは必ず Docker コンテナ内で実行すること。**

ホスト環境で `npm`、`node`、`npx` 等を直接実行しない。

### よく使うコマンド

```bash
# 開発サーバー起動
docker compose up

# コンテナ内でコマンド実行（一時的）
docker compose run --rm web <command>

# 例: npm install
docker compose run --rm web npm install <package>

# 例: テスト実行
docker compose run --rm web npm test

# 例: ビルド
docker compose run --rm web npm run build
```
