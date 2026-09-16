#!/usr/bin/env python3
"""
The chat.z.ai mock harness (Session Watchdog E2E).

A deterministic reproduction of the provider surface on 127.0.0.1:8099:

- the LIVE-OBSERVED DOM shapes (CTRL-014 ZAI_LOCATORS): #chat-input
  composer, #send-message-button, the bits-ui-style Stop wrapper
  (div[data-tooltip-trigger][aria-label="Stop"] > button), .chat-assistant
  rows, role="dialog" modals with a Cancel button;
- the server-side APIs the sensor probes: GET /api/v1/chats/list (the
  existence truth — a raw JSON array) and GET /api/v1/chats/<id> (the
  message tree with the assistant-placeholder fact);
- the auth surface: a localStorage 'token' carrying a JWT-shaped raw
  string with the operator email (lesson 46: raw JWT, guest = signed out);
- per-chat failure-mode controls (POST /control) reproducing every field
  lesson: freeze, silent generation, return, die, chat-id roll, wedge
  (hanging page load), queued (no assistant placeholder), capacity dialog,
  login death.

Stdlib only. Deterministic per control state — no clocks except the
explicitly-advanced per-chat updated_at.
"""

import base64
import json
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "127.0.0.1"
PORT = 8099

# ─────────────────────────── auth material ───────────────────────────


def b64url(obj: dict) -> str:
    raw = json.dumps(obj).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def make_jwt(email: str) -> str:
    return f"{b64url({'alg': 'none'})}.{b64url({'email': email})}.sig"


OPERATOR_EMAIL = "operator@payswap.org"
GUEST_EMAIL = "guest-1700000000@guest.com"

# ─────────────────────────── chat state ───────────────────────────


class Chat:
    def __init__(self, chat_id: str, title: str):
        self.id = chat_id
        self.title = title
        self.mode = "generating"  # generating|frozen|silent|queued|normal|returned|rolled|wedge|dead
        self.exists = True
        self.updated_at = time.time()
        self.updated_frozen = False
        self.signed_out = False
        self.dialog = None  # dict(text=..., with_cancel=True) when on
        self.roll_to = None
        self.mutation_script = True
        # the message tree: a completed user+assistant pair, plus an open
        # assistant placeholder while a turn is generating/frozen.
        self.messages = {
            "m-user-1": {
                "id": "m-user-1",
                "role": "user",
                "content": "Dispatch: implement the session watchdog.",
                "parentId": None,
                "childrenIds": ["m-assist-1"],
                "timestamp": 1,
            },
            "m-assist-1": {
                "id": "m-assist-1",
                "role": "assistant",
                "content": "Understood. Beginning implementation now.",
                "parentId": "m-user-1",
                "childrenIds": ["m-user-2"],
                "timestamp": 2,
            },
            "m-user-2": {
                "id": "m-user-2",
                "role": "user",
                "content": "Continue and deliver the files.",
                "parentId": "m-assist-1",
                "childrenIds": [],
                "timestamp": 3,
            },
        }
        self.placeholder_id = None  # set when a turn is open

    def open_turn(self):
        if self.placeholder_id:
            return
        pid = "m-assist-open"
        self.messages[pid] = {
            "id": pid,
            "role": "assistant",
            "content": None,
            "parentId": "m-user-2",
            "childrenIds": [],
            "timestamp": 4,
        }
        self.messages["m-user-2"]["childrenIds"] = [pid]
        self.placeholder_id = pid

    def close_turn(self, content: str):
        if self.placeholder_id:
            self.messages[self.placeholder_id]["content"] = content
            self.placeholder_id = None

    def touch(self):
        if not self.updated_frozen:
            self.updated_at = time.time()

    def has_assistant_content(self) -> bool:
        return any(
            m["role"] == "assistant" and m.get("content")
            for m in self.messages.values()
        )


CHATS: dict = {}
LOCK = threading.Lock()
CONTROLS: list = []  # audit trail


def new_chat(title: str) -> Chat:
    c = Chat(str(uuid.uuid4()), title)
    with LOCK:
        CHATS[c.id] = c
    return c


def get_chat(chat_id: str):
    with LOCK:
        return CHATS.get(chat_id)


def apply_control(chat_id: str, action: str, arg=None):
    with LOCK:
        chat = CHATS.get(chat_id)
        if not chat:
            return {"ok": False, "error": "unknown-chat"}
        CONTROLS.append({"ts": time.time(), "chat": chat_id, "action": action, "arg": arg})
        if action == "normal":
            chat.mode = "normal"
            chat.mutation_script = True
            chat.close_turn("Done. All files delivered.")
            chat.dialog = None
            chat.updated_frozen = False
            chat.touch()
        elif action == "generating":
            chat.mode = "generating"
            chat.mutation_script = True
            chat.open_turn()
            chat.dialog = None
            chat.updated_frozen = False
            chat.touch()
        elif action == "silent":
            # lesson 106: DOM quiet, server still working
            chat.mode = "silent"
            chat.mutation_script = False
            chat.open_turn()
            chat.updated_frozen = False
            chat.touch()
        elif action == "freeze":
            # lessons 36/37: open turn, DOM quiet, server updated_at frozen
            chat.mode = "frozen"
            chat.mutation_script = False
            chat.open_turn()
            chat.updated_frozen = True
        elif action == "queued":
            # lessons 48/89d: user message, NO assistant placeholder;
            # Stop control visible on the page
            chat.mode = "queued"
            chat.mutation_script = False
            chat.placeholder_id = None
            for m in list(chat.messages.values()):
                if m["role"] == "assistant":
                    m["content"] = None
            chat.updated_frozen = False
            chat.touch()
        elif action == "return":
            # one-shot: the next session-page load bounces home
            chat.mode = "returned"
        elif action == "die":
            # sticky: destroyed server-side (lesson 97)
            chat.mode = "dead"
            chat.exists = False
        elif action == "revive":
            chat.mode = "generating"
            chat.exists = True
            chat.mutation_script = True
            chat.open_turn()
            chat.updated_frozen = False
            chat.touch()
        elif action == "roll":
            # lesson 51/76/95: the chat id rolls to a new uuid; the OLD id
            # becomes a redirect alias (the observed redirect chains), the
            # list carries only the new id
            new_id = str(uuid.uuid4())
            rolled = Chat(new_id, chat.title + " (rolled)")
            rolled.mode = "generating"
            rolled.mutation_script = True
            rolled.messages = dict(chat.messages)
            rolled.placeholder_id = chat.placeholder_id
            rolled.open_turn()
            CHATS[new_id] = rolled
            chat.exists = False  # absent from the list (old id is dead)
            chat.roll_to = new_id  # but /c/<old> redirects to the new id
            return {"ok": True, "newId": new_id}
        elif action == "wedge":
            # the page load hangs forever (renderer never answers)
            chat.mode = "wedge"
        elif action == "dialog":
            chat.dialog = {
                "text": arg or "Currently in peak hours. Please try again later.",
                "with_cancel": True,
            }
        elif action == "dialog-clear":
            chat.dialog = None
        elif action == "signed-out":
            chat.signed_out = True
        elif action == "signed-in":
            chat.signed_out = False
        else:
            return {"ok": False, "error": f"unknown-action:{action}"}
        return {"ok": True}


# ─────────────────────────── page templates ───────────────────────────

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title} — chat.z.ai (harness)</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #101012; color: #ececef; margin: 0; padding: 24px; }}
  .row {{ max-width: 640px; margin: 10px 0; padding: 10px 12px; border-radius: 10px; }}
  .chat-assistant {{ background: #1a1a1e; border: 1px solid #2e2e34; }}
  .user-message {{ background: #143629; }}
  #composer {{ position: fixed; bottom: 16px; left: 24px; right: 24px; display: flex; gap: 8px; }}
  #chat-input {{ flex: 1; min-height: 44px; border-radius: 10px; border: 1px solid #2e2e34;
                 background: #1a1a1e; color: inherit; padding: 10px; }}
  #send-message-button {{ width: 44px; height: 44px; border-radius: 10px; border: none; cursor: pointer; }}
  .modal-cover {{ position: fixed; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; z-index: 500; }}
  div[role="dialog"] {{ background: #1a1a1e; border: 1px solid #2e2e34; border-radius: 12px;
                        padding: 20px; max-width: 360px; text-align: center; }}
</style>
</head>
<body>
<main>
  <h3>{title}</h3>
  <div class="row user-message">Dispatch: implement the session watchdog.</div>
  <div class="row chat-assistant" id="stream">{assistant}</div>
</main>
<div id="composer">
  <textarea id="chat-input" aria-label="message input" placeholder="Send a message..."></textarea>
  {action_slot}
</div>
{dialog}
<script>
(function () {{
  try {{
    var email = {email_json};
    var token = "{token}";
    if (token) localStorage.setItem('token', token);
  }} catch (e) {{}}
  {stream_block}
}})();
</script>
</body>
</html>"""

ACTION_SLOT_STOP = (
    '<div data-tooltip-trigger aria-label="Stop">'
    '<button aria-label="stop button" id="stop-button">■</button></div>'
)
ACTION_SLOT_SEND = '<button id="send-message-button" aria-label="send button">➤</button>'

DIALOG_HTML = """
<div class="modal-cover" id="modal-cover">
  <div role="dialog" aria-modal="true" data-state="open">
    <p>{text}</p>
    <button id="cancel-btn">Cancel</button>
    <button id="switch-btn">Switch to GLM-5.3-Flash</button>
  </div>
</div>
<script>
(function () {
  var cancel = document.getElementById('cancel-btn');
  if (cancel) cancel.addEventListener('click', function () {
    var cover = document.getElementById('modal-cover');
    if (cover) cover.remove();
  });
})();
</script>
"""

HOME_PAGE = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>chat.z.ai (harness)</title>
<style>body{{font-family:system-ui,sans-serif;background:#101012;color:#ececef;display:grid;place-items:center;height:100vh;margin:0}}</style>
</head>
<body><div><h2>chat.z.ai</h2><p>New chat — pick a mode to begin.</p>
<textarea id="chat-input" aria-label="message input" placeholder="Send a message..."></textarea>
<button id="send-message-button" aria-label="send button">➤</button></div>
<script>try{{localStorage.setItem('token', "{token}");}}catch(e){{}}</script>
</body>
</html>"""


STREAM_JS = """
  var stream = document.getElementById('stream');
  if (stream) {
    var base = stream.textContent;
    var i = 0;
    setInterval(function () {
      i += 1;
      stream.textContent = base + ' [working ' + i + ']';
    }, 700);
  }
"""
STATIC_JS = "  /* static DOM: no streaming (frozen/queued) */"


def render_page(chat: Chat) -> str:
    turn_open = chat.mode in ("generating", "frozen", "silent", "queued")
    assistant = "Understood. Beginning implementation now." if chat.has_assistant_content() else ""
    email = GUEST_EMAIL if chat.signed_out else OPERATOR_EMAIL
    token = make_jwt(email)
    if chat.mode == "queued":
        # the action slot is swapped to Stop while the turn is queued
        # (the observed queued-capacity surface)
        slot = ACTION_SLOT_STOP
        stream = STATIC_JS
    elif turn_open:
        slot = ACTION_SLOT_STOP
        stream = STREAM_JS if chat.mutation_script else STATIC_JS
    else:
        slot = ACTION_SLOT_SEND
        stream = STATIC_JS
    dialog = DIALOG_HTML.replace("{text}", chat.dialog["text"]) if chat.dialog else ""
    return PAGE.format(
        title=chat.title,
        assistant=assistant,
        action_slot=slot,
        dialog=dialog,
        token=token,
        email_json=json.dumps(email),
        stream_block=stream,
    )


# ─────────────────────────── HTTP handler ───────────────────────────


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/healthz":
            self._json(200, {"ok": True, "chats": len(CHATS)})
            return

        if path == "/api/v1/chats/list":
            with LOCK:
                items = []
                for c in CHATS.values():
                    if not c.exists:
                        continue
                    # the server's own clock: active work advances the
                    # chat's updated_at (generating/silent); queued and
                    # frozen chats hold it static (the observed shapes)
                    if c.mode in ("generating", "silent"):
                        c.touch()
                    items.append(
                        {
                            "id": c.id,
                            "title": c.title,
                            "updated_at": time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(c.updated_at)
                            ),
                        }
                    )
            self._send(200, json.dumps(items).encode(), "application/json")
            return

        m = re.match(r"^/api/v1/chats/([0-9a-fA-F-]+)$", path)
        if m:
            chat = get_chat(m.group(1))
            if not chat or not chat.exists:
                self._json(404, {"error": "chat not found"})
                return
            # NOTE: no touch() here — the LIST read is the server clock;
            # the tree is a static snapshot (updated_at comes from the list)
            self._json(
                200,
                {"chat": {"id": chat.id, "title": chat.title, "history": {"messages": chat.messages}}},
            )
            return

        m = re.match(r"^/c/([0-9a-fA-F-]{6,64})(?:/.*)?$", path)
        if m:
            chat = get_chat(m.group(1))
            if chat and chat.roll_to:
                # the rolled old id redirects to the new session URL
                self.send_response(302)
                self.send_header("Location", f"/c/{chat.roll_to}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if not chat or not chat.exists:
                # destroyed chat: redirect home (the death certificate)
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if chat.mode == "returned":
                # one-shot: bounce the tab home, then reset to generating
                chat.mode = "generating"
                chat.mutation_script = True
                chat.open_turn()
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if chat.mode == "wedge":
                # headers now, body never completes: the navigation COMMITTS
                # (the old page unloads, its content script dies) while the
                # document stays pending forever — the renderer that never
                # finishes answering
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", "100000")
                self.end_headers()
                try:
                    self.wfile.write(b"<html><body>loading...")
                    self.wfile.flush()
                except Exception:
                    pass
                time.sleep(600)
                return
            self._send(200, render_page(chat).encode(), "text/html")
            return

        if path == "/":
            email = GUEST_EMAIL
            token = make_jwt(OPERATOR_EMAIL)
            # home keeps the operator token (still signed in site-wide)
            with LOCK:
                any_chat = next(iter(CHATS.values()), None)
                if any_chat and any_chat.signed_out:
                    token = make_jwt(GUEST_EMAIL)
            self._send(200, HOME_PAGE.format(token=token).encode(), "text/html")
            return

        self._json(404, {"error": "not-found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/control":
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            chat_id = body.get("chat")
            action = body.get("action")
            arg = body.get("arg")
            if not chat_id or not action:
                self._json(400, {"ok": False, "error": "chat+action required"})
                return
            result = apply_control(chat_id, action, arg)
            self._json(200 if result.get("ok") else 400, result)
            return
        if parsed.path == "/new":
            body = {}
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                body = json.loads(self.rfile.read(length))
            chat = new_chat(body.get("title") or "Worker session")
            chat.open_turn()
            self._json(200, {"ok": True, "id": chat.id})
            return
        self._json(404, {"error": "not-found"})


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"harness on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
