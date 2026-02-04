from flask import Flask, request, jsonify, render_template
import os
import csv
import requests
from datetime import datetime
import tempfile

# -------------------------
# CONFIG (edit these)
# -------------------------
OLLAMA_HOST = "http://192.168.1.50:11434"   # <-- change to your Ollama server
OLLAMA_MODEL = "llama3.1:8b"                # <-- change to your model
USE_OLLAMA_CHAT_ENDPOINT = True             # True: /api/chat, False: /api/generate

# Optional server-side STT (microphone selection supported via MediaRecorder in browser)
# Install: pip install faster-whisper
# Also requires ffmpeg available on the server.
ENABLE_SERVER_STT = True
WHISPER_MODEL_SIZE = "small"  # tiny, base, small, medium, large-v3 (bigger = better + slower)

PORT = 8000
HOST = "0.0.0.0"

# Where personalities are saved (same directory as app.py)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PERSONALITIES_CSV = os.path.join(BASE_DIR, "personalities.csv")

app = Flask(__name__)

# Lazy-loaded whisper model
_whisper_model = None


# -------------------------
# CSV helpers
# -------------------------
CSV_HEADERS = ["name", "system_prompt", "updated_at"]

def ensure_csv_exists():
    if not os.path.exists(PERSONALITIES_CSV):
        with open(PERSONALITIES_CSV, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
            writer.writeheader()

def read_personalities():
    ensure_csv_exists()
    items = []
    with open(PERSONALITIES_CSV, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("name") or "").strip()
            prompt = row.get("system_prompt") or ""
            updated_at = row.get("updated_at") or ""
            if name:
                items.append({"name": name, "system_prompt": prompt, "updated_at": updated_at})
    items.sort(key=lambda x: x["name"].lower())
    return items

def upsert_personality(name: str, system_prompt: str):
    ensure_csv_exists()
    name = name.strip()
    now = datetime.now().isoformat(timespec="seconds")

    items = read_personalities()
    found = False
    for it in items:
        if it["name"].lower() == name.lower():
            it["name"] = name
            it["system_prompt"] = system_prompt
            it["updated_at"] = now
            found = True
            break

    if not found:
        items.append({"name": name, "system_prompt": system_prompt, "updated_at": now})

    with open(PERSONALITIES_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        writer.writeheader()
        for it in items:
            writer.writerow(it)

def get_personality(name: str):
    name = name.strip()
    for it in read_personalities():
        if it["name"].lower() == name.lower():
            return it
    return None


# -------------------------
# Ollama calls
# -------------------------
def ollama_chat(system_prompt: str, user_message: str):
    url = f"{OLLAMA_HOST}/api/chat"
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": system_prompt or "You are a helpful assistant."},
            {"role": "user", "content": user_message},
        ],
    }
    r = requests.post(url, json=payload, timeout=180)
    r.raise_for_status()
    data = r.json()
    msg = (data.get("message") or {}).get("content") or ""
    return msg.strip()

def ollama_generate(system_prompt: str, user_message: str):
    url = f"{OLLAMA_HOST}/api/generate"
    prompt = (system_prompt or "You are a helpful assistant.").strip() + "\n\nUser: " + user_message.strip() + "\nAssistant:"
    payload = {"model": OLLAMA_MODEL, "stream": False, "prompt": prompt}
    r = requests.post(url, json=payload, timeout=180)
    r.raise_for_status()
    data = r.json()
    resp = data.get("response") or ""
    return resp.strip()

def ask_ollama(system_prompt: str, user_message: str):
    if USE_OLLAMA_CHAT_ENDPOINT:
        return ollama_chat(system_prompt, user_message)
    return ollama_generate(system_prompt, user_message)


# -------------------------
# Server-side STT (optional)
# -------------------------
def get_whisper_model():
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    if not ENABLE_SERVER_STT:
        raise RuntimeError("Server STT is disabled in app.py (ENABLE_SERVER_STT=False).")

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        raise RuntimeError(
            "faster-whisper is not installed. Install with: pip install faster-whisper\n"
            f"Original import error: {e}"
        )

    # device="auto" chooses CUDA if available
    _whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="auto", compute_type="auto")
    return _whisper_model

def transcribe_file(path: str):
    model = get_whisper_model()
    segments, info = model.transcribe(path, beam_size=5, vad_filter=True)
    text_parts = []
    for seg in segments:
        if seg.text:
            text_parts.append(seg.text.strip())
    return " ".join(text_parts).strip()


# -------------------------
# Routes
# -------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({
        "ok": True,
        "ollama_host": OLLAMA_HOST,
        "ollama_model": OLLAMA_MODEL,
        "chat_endpoint": "/api/chat" if USE_OLLAMA_CHAT_ENDPOINT else "/api/generate",
        "server_stt_enabled": bool(ENABLE_SERVER_STT),
        "whisper_model": WHISPER_MODEL_SIZE if ENABLE_SERVER_STT else None
    })


@app.route("/api/personalities", methods=["GET"])
def api_list_personalities():
    return jsonify({"ok": True, "items": read_personalities()})


@app.route("/api/personalities/save", methods=["POST"])
def api_save_personality():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    system_prompt = data.get("system_prompt") or ""

    if not name:
        return jsonify({"ok": False, "error": "Missing personality name."}), 400

    upsert_personality(name, system_prompt)
    return jsonify({"ok": True})


@app.route("/api/personalities/load", methods=["POST"])
def api_load_personality():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Missing personality name."}), 400

    it = get_personality(name)
    if not it:
        return jsonify({"ok": False, "error": f"Personality '{name}' not found."}), 404

    return jsonify({"ok": True, "item": it})


@app.route("/api/chat", methods=["POST"])
def api_chat():
    data = request.get_json(force=True, silent=True) or {}
    system_prompt = data.get("system_prompt") or ""
    user_message = (data.get("user_message") or "").strip()

    if not user_message:
        return jsonify({"ok": False, "error": "Empty message."}), 400

    try:
        assistant_text = ask_ollama(system_prompt, user_message)
        return jsonify({"ok": True, "assistant": assistant_text})
    except requests.exceptions.RequestException as e:
        return jsonify({"ok": False, "error": f"Ollama request failed: {str(e)}"}), 502
    except Exception as e:
        return jsonify({"ok": False, "error": f"Server error: {str(e)}"}), 500


@app.route("/api/stt", methods=["POST"])
def api_stt():
    """
    Accepts audio as multipart/form-data under field name 'audio'.
    Expects formats like audio/webm (MediaRecorder). faster-whisper uses ffmpeg to decode.
    Returns: {ok: true, text: "..."}
    """
    if not ENABLE_SERVER_STT:
        return jsonify({"ok": False, "error": "Server STT is disabled in app.py."}), 400

    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "Missing 'audio' file field."}), 400

    audio_file = request.files["audio"]
    if not audio_file.filename:
        # still fine, but ensure we have a suffix
        filename = "audio.webm"
    else:
        filename = audio_file.filename

    suffix = os.path.splitext(filename)[1] or ".webm"

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            audio_file.save(tmp_path)

        text = transcribe_file(tmp_path)
        return jsonify({"ok": True, "text": text})
    except Exception as e:
        return jsonify({"ok": False, "error": f"STT failed: {str(e)}"}), 500
    finally:
        try:
            if 'tmp_path' in locals() and os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    ensure_csv_exists()
    app.run(host=HOST, port=PORT, debug=True)
