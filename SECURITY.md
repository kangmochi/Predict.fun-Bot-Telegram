# Security

This bot can spend **real USDT** and can drain a wallet if the private key leaks. Treat `.env` like cash.

## Never publish

Do **not** commit, screenshot, paste into issues, Discord, Telegram groups, or YouTube:

- `PRIVY_WALLET_PRIVATE_KEY` (or any wallet seed / private key)
- `PREDICT_API_KEY`
- `VIKEY_API_KEY` / `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- A filled `.env` file
- SSH passwords or `~/.ssh` private keys
- Deposit addresses **together with** private keys (address alone is public; the key is not)

The file `.env.example` is the only env template that belongs in git. It must stay empty of real values.

## Before you push to GitHub

```bash
git status
git diff
# Confirm .env is not listed. If it is:
git restore --staged .env
```

If you already pushed a secret: **rotate it immediately** (new API keys, new Telegram token, move funds off that wallet). Deleting the commit is not enough — the key is burned.

## On the VPS

- SSH as a normal user (`ubuntu`), not with keys pasted into chat
- `chmod 600 .env`
- Do not install random “AI agent CLIs” or remote-control tools you do not understand
- One live bot only. Two VPS both running `--live` on the same wallet can double-buy
