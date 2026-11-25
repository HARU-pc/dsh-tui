## DSH 0.2.0-rc.2 SDK モード（このブランチ）

```bash
npm ci
dsh-tui .
# リポジトリから直接起動:
node bin/tui.js .
# 一回の応答を標準出力へ:
node bin/tui.js run '質問' --cwd .
```

DSH を `dsh --profile sdk` で子プロセスとして起動し、stdio JSON-RPC を使用します。作業ディレクトリは引数のディレクトリです。`DSH_SDK_COMMAND` で起動コマンドを変更できます（信頼するシェルコマンドのみ）。モデルは `DSH_SDK_PROVIDER` / `DSH_SDK_MODEL` で指定可能で、既定値は `deepseek-official` / `deepseek-v4-pro` です。認証は DSH が管理します。

起動時は新規 composer を表示します。履歴・セッション一覧/再開・subagent 一覧・中断・旧 host コマンド・承認応答は SDK モードでは未対応です。中断操作で子プロセスを kill しません。返信は SDK の確定メッセージ通知で表示され、文字単位のストリーミングはありません。終了時は `shutdown` を送信して子プロセスの終了を必ず待ち、応答しない子は SIGTERM→SIGKILL で終了させます。異常終了は非0、`run` 中の SIGINT/SIGTERM は 130/143 です。SDK の初期化は専用の待ち時間（既定120秒）を使います。明示的な JSON-RPC 拒否だけは子が生きていれば再試行できます。タイムアウトは処理済みか不明なため致命的失敗とし、終了処理後に新しい client を作る必要があります。対話 UI は SDK の初期化完了を待たずに表示され、初期化前の入力は初期化後に順番どおり送信されます。`run --json` は旧形式のフィールドを維持します（スキーマは docs 参照）。Unix 環境を対象とします。

設計・対応表・制限は [docs/dsh-0.2-sdk.md](docs/dsh-0.2-sdk.md) を参照してください。移植前の web モードに関する upstream の説明は [docs/legacy-web-readme.md](docs/legacy-web-readme.md) に退避しました（このブランチには適用されません）。

この移植は破壊的変更を含む **0.3.0** です。旧 `new DshClient(url)` はエラーになります。`new DshClient({ cwd })` に移行してください。その他の変更は [移行手順](docs/dsh-0.2-sdk.md#030-breaking-changes-and-migration) を参照してください。
