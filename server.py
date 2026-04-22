"""Two Truths & One Lie — Python server (stdlib HTTP + websockets)"""

import asyncio
import json
import os
import pathlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import websockets

BASE = pathlib.Path(__file__).parent
PUBLIC = BASE / "public"
DATA_FILE = BASE / "data" / "game.json"

game_data = json.loads(DATA_FILE.read_text())

state = {
    "phase": "lobby",
    "currentSlide": 0,
    "currentRevealSlide": 0,
    "votes": {},
    "revealedSlides": [],
}

ws_clients = set()
ws_lock = asyncio.Lock()
_loop = None  # asyncio event loop, set at startup


# ── helpers ──────────────────────────────────────────────────────────────────

def public_state():
    slide_votes = state["votes"].get(state["currentSlide"], {})
    return {
        "phase": state["phase"],
        "currentSlide": state["currentSlide"],
        "currentRevealSlide": state["currentRevealSlide"],
        "totalSlides": len(game_data["slides"]),
        "revealedSlides": state["revealedSlides"],
        "voteCount": len(slide_votes),
    }


def compute_scores():
    scores = {p: 0 for p in game_data["players"]}
    for i, slide in enumerate(game_data["slides"]):
        for vote in state["votes"].get(i, {}).values():
            who_ok = vote["guessedName"] == slide["correctName"]
            lie_ok = vote["lieIndex"] == slide["lieIndex"]
            if who_ok and lie_ok:
                scores[vote["voter"]] = scores.get(vote["voter"], 0) + 5
            else:
                if who_ok:
                    scores[vote["voter"]] = scores.get(vote["voter"], 0) + 2
                if lie_ok:
                    scores[vote["voter"]] = scores.get(vote["voter"], 0) + 2
    return scores


def compute_most_mysterious():
    fooled = {p: 0 for p in game_data["players"]}
    for i, slide in enumerate(game_data["slides"]):
        wrong = sum(1 for v in state["votes"].get(i, {}).values()
                    if v["guessedName"] != slide["correctName"])
        fooled[slide["correctName"]] = fooled.get(slide["correctName"], 0) + wrong
    best = max(fooled, key=fooled.get)
    return {"player": best, "count": fooled[best]}


def get_reveal_data(idx):
    slide = game_data["slides"][idx]
    all_votes = list(state["votes"].get(idx, {}).values())
    name_counts = {p: 0 for p in game_data["players"]}
    lie_counts = {0: 0, 1: 0, 2: 0}
    for v in all_votes:
        name_counts[v["guessedName"]] = name_counts.get(v["guessedName"], 0) + 1
        lie_counts[v["lieIndex"]] = lie_counts.get(v["lieIndex"], 0) + 1
    return {
        "slideIndex": idx,
        "statements": slide["statements"],
        "correctName": slide["correctName"],
        "lieIndex": slide["lieIndex"],
        "nameCounts": name_counts,
        "lieIndexCounts": lie_counts,
        "whoCorrectCount": sum(1 for v in all_votes if v["guessedName"] == slide["correctName"]),
        "lieCorrectCount": sum(1 for v in all_votes if v["lieIndex"] == slide["lieIndex"]),
        "totalVotes": len(all_votes),
    }


def broadcast_sync(payload):
    """Thread-safe broadcast from HTTP thread into asyncio loop."""
    if _loop and not _loop.is_closed():
        asyncio.run_coroutine_threadsafe(_broadcast(payload), _loop)


async def _broadcast(payload):
    msg = json.dumps(payload)
    async with ws_lock:
        dead = set()
        for ws in ws_clients:
            try:
                await ws.send(msg)
            except Exception:
                dead.add(ws)
        ws_clients.difference_update(dead)


# ── HTTP handler ─────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence default logging

    def send_json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def send_index(self):
        html = (PUBLIC / "index.html").read_text()
        inject = f"<script>window.__WS_PORT__={WS_PORT};</script>"
        html = html.replace("</head>", inject + "</head>", 1)
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        try:
            content = path.read_bytes()
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()
            return
        ext = path.suffix
        ct = {
            ".html": "text/html",
            ".css": "text/css",
            ".js": "application/javascript",
            ".json": "application/json",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", len(content))
        self.end_headers()
        self.wfile.write(content)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def is_admin(self):
        return self.headers.get("x-admin-token") == game_data["adminPassword"]

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/state":
            return self.send_json(public_state())

        if path == "/api/game-data":
            return self.send_json({
                "players": game_data["players"],
                "totalSlides": len(game_data["slides"]),
                "currentSlideStatements": game_data["slides"][state["currentSlide"]]["statements"],
            })

        if path == "/api/admin/full-state":
            if not self.is_admin():
                return self.send_json({"error": "Unauthorized"}, 401)
            return self.send_json({
                "state": state,
                "gameData": game_data,
                "scores": compute_scores(),
                "mostMysterious": compute_most_mysterious(),
            })

        if path == "/api/voted":
            qs = parse_qs(parsed.query)
            name = (qs.get("name") or [""])[0]
            voted = name in state["votes"].get(state["currentSlide"], {})
            return self.send_json({"voted": voted})

        # Static files
        if path == "/" or path == "":
            return self.send_index()
        file_path = PUBLIC / path.lstrip("/")
        if file_path.is_file():
            return self.send_file(file_path)
        return self.send_index()

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        path = urlparse(self.path).path
        body = self.read_body()

        if path == "/api/admin/login":
            if body.get("password") == game_data["adminPassword"]:
                return self.send_json({"ok": True, "token": game_data["adminPassword"]})
            return self.send_json({"error": "Wrong password"}, 401)

        if path == "/api/vote":
            if state["phase"] != "voting":
                return self.send_json({"error": "Voting is not open"}, 400)
            voter = body.get("voterName")
            guess = body.get("guessedName")
            lie = body.get("lieIndex")
            if voter not in game_data["players"] or guess not in game_data["players"]:
                return self.send_json({"error": "Invalid player"}, 400)
            slide_votes = state["votes"].setdefault(state["currentSlide"], {})
            if voter in slide_votes:
                return self.send_json({"error": "Already voted"}, 400)
            slide_votes[voter] = {"voter": voter, "guessedName": guess, "lieIndex": int(lie)}
            broadcast_sync({"type": "state", "data": public_state()})
            return self.send_json({"ok": True})

        if not self.is_admin():
            return self.send_json({"error": "Unauthorized"}, 401)

        if path == "/api/admin/open-voting":
            if state["phase"] not in ("lobby", "closed"):
                return self.send_json({"error": "Invalid phase"}, 400)
            state["phase"] = "voting"
            broadcast_sync({"type": "state", "data": public_state()})
            return self.send_json({"ok": True})

        if path == "/api/admin/close-voting":
            if state["phase"] != "voting":
                return self.send_json({"error": "Not voting"}, 400)
            state["phase"] = "closed"
            broadcast_sync({"type": "state", "data": public_state()})
            return self.send_json({"ok": True})

        if path == "/api/admin/next-round":
            if state["phase"] != "closed":
                return self.send_json({"error": "Must close voting first"}, 400)
            if state["currentSlide"] >= len(game_data["slides"]) - 1:
                state["phase"] = "reveal"
                state["currentRevealSlide"] = 0
            else:
                state["currentSlide"] += 1
                state["phase"] = "lobby"
            broadcast_sync({"type": "state", "data": public_state()})
            return self.send_json({"ok": True, "phase": state["phase"]})

        if path == "/api/admin/reveal-next":
            if state["phase"] != "reveal":
                return self.send_json({"error": "Not in reveal phase"}, 400)
            idx = state["currentRevealSlide"]
            data = get_reveal_data(idx)
            if idx not in state["revealedSlides"]:
                state["revealedSlides"].append(idx)
            if state["currentRevealSlide"] < len(game_data["slides"]) - 1:
                state["currentRevealSlide"] += 1
            broadcast_sync({"type": "reveal", "data": {**data, "publicState": public_state()}})
            return self.send_json({"ok": True, "revealData": data})

        if path == "/api/admin/show-leaderboard":
            state["phase"] = "leaderboard"
            scores = compute_scores()
            mm = compute_most_mysterious()
            best = max(scores, key=scores.get)
            leaderboard = sorted(
                [{"name": n, "score": s} for n, s in scores.items()],
                key=lambda r: -r["score"],
            )
            broadcast_sync({
                "type": "leaderboard",
                "data": {"leaderboard": leaderboard, "bestDetective": best,
                         "mostMysterious": mm, "publicState": public_state()},
            })
            return self.send_json({"ok": True, "leaderboard": leaderboard,
                                   "bestDetective": best, "mostMysterious": mm})

        if path == "/api/admin/reset":
            state.update({
                "phase": "lobby", "currentSlide": 0,
                "currentRevealSlide": 0, "votes": {}, "revealedSlides": [],
            })
            broadcast_sync({"type": "state", "data": public_state()})
            return self.send_json({"ok": True})

        self.send_json({"error": "Not found"}, 404)


# ── WebSocket server ──────────────────────────────────────────────────────────

async def ws_handler(websocket):
    async with ws_lock:
        ws_clients.add(websocket)
    try:
        await websocket.send(json.dumps({"type": "state", "data": public_state()}))
        await websocket.wait_closed()
    finally:
        async with ws_lock:
            ws_clients.discard(websocket)


async def run_ws(port):
    async with websockets.serve(ws_handler, "0.0.0.0", port):
        await asyncio.Future()  # run forever


def run_http(port):
    server = HTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


# ── main ─────────────────────────────────────────────────────────────────────

HTTP_PORT = int(os.environ.get("PORT", 3000))
WS_PORT = HTTP_PORT + 1

if __name__ == "__main__":
    print(f"Two Truths & One Lie")
    print(f"  HTTP : http://localhost:{HTTP_PORT}")
    print(f"  WS   : ws://localhost:{WS_PORT}")
    print(f"  Admin password: {game_data['adminPassword']}")

    loop = asyncio.new_event_loop()
    _loop = loop

    # Run WebSocket in asyncio thread
    def start_ws():
        asyncio.set_event_loop(loop)
        loop.run_until_complete(run_ws(WS_PORT))

    t = threading.Thread(target=start_ws, daemon=True)
    t.start()

    # HTTP server in main thread
    run_http(HTTP_PORT)
