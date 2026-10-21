# Minecraft Bodyguard

Mineflayer bodyguards managed by a master connection and up to five Node worker threads. Only the master connects at startup; numbered clones connect after the owner uses `!clones`.

## Setup

1. Install Node.js 18+ and run `npm install`.
2. Copy `.env.example` to `.env` and export the values in your shell (or use a dotenv loader). The default owner is `tails1154`; change `OWNER_NAME` if needed.
3. Set `MC_HOST`, `MC_PORT`, `MC_AUTH`, `BOT_USERNAME`, `BODYGUARD_COUNT` (1–5), and `AUTHME_PASSWORD`.
4. Start with `npm start`.

The bot usernames are `<BOT_USERNAME>_1`, `<BOT_USERNAME>_2`, and so on. AuthMe servers receive `/register password password`, wait for the server response, and then receive `/login password`; login is retried if needed. Set `AUTHME_REGISTER_COMMAND` and `AUTHME_LOGIN_COMMAND` for servers using aliases such as `/reg` and `/l`. Use a different password per deployment and keep it out of source control.

## In-game commands

- `!claim` — the first player to use it becomes the owner.
- `!help` — show the available commands in chat.
- `!clones` — owner-only deployment of the numbered bodyguards.
- `!guards status` — owner-only connection status.
- `!guards follow` — owner-only follow refresh.
- `!guards off` — owner-only disconnect for all instances.
- `!guards betray` — owner-only joke mode: guards attack the owner until `!guards follow`.

`!bodyguard off`, `!guards stop`, and `!guards release` are aliases for disconnecting. `stop` in the process terminal does the same thing. The owner and all bodyguard usernames are protected; when a nearby entity hurts or swings near a protected player, workers broadcast the target and attack it.

The main Node thread is the master coordinator. Each Mineflayer worker has a separate signaling worker that forwards hit alerts to the master, which then broadcasts a defense order to the other guards. Guards keep fighting while the threat remains active, stop when it dies or the alert expires, and flee with pathfinding at three hearts or less before returning to normal follow behavior.

After deployment, each clone announces `Bodyguard for <owner>. Ready for commands.` When a clone picks up dropped armor or a supported weapon, it says `Thanks!` and equips the item automatically.

This is intended for servers where bot accounts and automation are allowed. It does not bypass server anti-bot rules.
