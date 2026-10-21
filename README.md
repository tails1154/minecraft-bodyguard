# Minecraft Bodyguard

Mineflayer bodyguards managed by a coordinator and up to five Node worker threads.

## Setup

1. Install Node.js 18+ and run `npm install`.
2. Copy `.env.example` to `.env` and export the values in your shell (or use a dotenv loader).
3. Set `MC_HOST`, `MC_PORT`, `MC_AUTH`, `BOT_USERNAME`, `BODYGUARD_COUNT` (1–5), and `AUTHME_PASSWORD`.
4. Start with `npm start`.

The bot usernames are `<BOT_USERNAME>_1`, `<BOT_USERNAME>_2`, and so on. AuthMe servers receive both `/register password password` and `/login password` after spawn when `AUTHME_PASSWORD` is set. Use a different password per deployment and keep it out of source control.

## In-game commands

- `!claim` — the first player to use it becomes the owner.
- `!guards status` — owner-only connection status.
- `!guards follow` — owner-only follow refresh.
- `!guards off` — owner-only disconnect for all instances.
- `!guards betray` — owner-only joke mode: guards attack the owner until `!guards follow`.

`!bodyguard off`, `!guards stop`, and `!guards release` are aliases for disconnecting. `stop` in the process terminal does the same thing. The owner and all bodyguard usernames are protected; when a nearby entity hurts or swings near a protected player, workers broadcast the target and attack it.

The main Node thread is the master coordinator. Each Mineflayer worker has a separate signaling worker that forwards hit alerts to the master, which then broadcasts a defense order to the other guards. Guards keep fighting while the threat remains active, stop when it dies or the alert expires, and flee with pathfinding at three hearts or less before returning to normal follow behavior.

This is intended for servers where bot accounts and automation are allowed. It does not bypass server anti-bot rules.
