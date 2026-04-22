# Two Truths & One Lie

A real-time party game web app for 12–14 players. No app download required — players join via a shared URL on their phone browser.

## How to Play

Each round, three statements appear on screen. Players guess **who** the statements belong to and **which one is the lie**. After all rounds are complete, the host reveals answers one by one, then shows the final leaderboard.

## Scoring

| Correct guess | Points |
|---|---|
| WHO (correct person) | 2 pts |
| LIE (correct statement) | 2 pts |
| Both correct | 5 pts (bonus) |

**Best Detective** — highest score  
**Most Mysterious** — fooled the most people

## Setup

### Requirements

- Python 3.8+
- `websockets` library

```bash
pip install websockets
```

### Run

```bash
python3 server.py
```

The server starts on port 3000. Share `http://<your-ip>:3000` with players on the same network.

## Game Views

### Player view (`http://<host>:3000`)
- Choose your name from the dropdown
- Each round: pick who the statements belong to + which is the lie
- Locked after submitting — shows a waiting screen until the next round
- No scores or answers revealed during the game

### Admin view (same URL → Admin Login)
- Password protected (set in `data/game.json`)
- Controls per round: **Open Voting → Close Voting → Next Round**
- After all rounds: step through each slide in the **Reveal Phase**
- Trigger the **Final Leaderboard** when done

### Reveal view (admin-controlled, shown on main screen)
- Vote breakdown per slide (who people guessed, which lie they picked)
- Correct name and lie revealed
- Counts of who got WHO right and LIE right

### Leaderboard
- Full ranked scores for all players
- Best Detective and Most Mysterious awards

## Customising Game Data

Edit [`data/game.json`](data/game.json):

```json
{
  "adminPassword": "your-password",
  "players": ["Alice", "Bob", "Charlie", ...],
  "slides": [
    {
      "statements": [
        "Statement one",
        "Statement two",
        "Statement three"
      ],
      "correctName": "Alice",
      "lieIndex": 1
    }
  ]
}
```

- `lieIndex` is 0-based (0 = first statement, 1 = second, 2 = third)
- Add one slide per player
- Restart the server after editing

## Tech Stack

- **Backend**: Python 3 standard library HTTP server + [`websockets`](https://websockets.readthedocs.io/)
- **Frontend**: Vanilla HTML/CSS/JS — no framework, no build step
- **Real-time**: WebSocket broadcast for live vote counts and phase changes
