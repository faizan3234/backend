"""
RELIV Voice Service Configuration.
Loads environment variables with safe defaults for Raspberry Pi kiosk deployment.
"""
import os

# Service Networking
HOST = os.getenv("RELIV_VOICE_HOST", "127.0.0.1")
PORT = int(os.getenv("RELIV_VOICE_PORT", "5100"))

# Audio Hardware & Format
MIC_DEVICE_HINT = os.getenv("RELIV_MIC_DEVICE_HINT", "PCM2902")
MIC_DEVICE_FALLBACK = os.getenv("RELIV_MIC_DEVICE", "plughw:3,0")
SAMPLE_RATE = int(os.getenv("RELIV_SAMPLE_RATE", "16000"))
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM (S16_LE)
FRAME_MS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MS // 1000
BYTES_PER_FRAME = SAMPLES_PER_FRAME * SAMPLE_WIDTH

# Voice Activity Detection (VAD)
VAD_RMS = int(os.getenv("RELIV_VAD_RMS", "150"))
VAD_START_FRAMES = int(os.getenv("RELIV_VAD_START_FRAMES", "3"))
VAD_END_SILENCE_MS = int(os.getenv("RELIV_VAD_END_MS", "1200"))
VAD_MIN_SPEECH_MS = int(os.getenv("RELIV_VAD_MIN_MS", "150"))
VAD_MAX_UTTERANCE_MS = int(os.getenv("RELIV_VAD_MAX_MS", "12000"))
VAD_PREROLL_MS = int(os.getenv("RELIV_VAD_PREROLL_MS", "240"))

# Whisper ASR
WHISPER_URL = os.getenv("RELIV_WHISPER_URL", "http://127.0.0.1:8081/inference")
WHISPER_TIMEOUT_SECS = int(os.getenv("RELIV_WHISPER_TIMEOUT", "30"))

# Barge-In & Echo Suppression
# Default 0 (disabled): suppress mic input while RELIV speaker is playing
ALLOW_BARGE_IN = os.getenv("RELIV_ALLOW_BARGE_IN", "0") == "1"

# Allowed CORS / WebSocket Origins
ALLOWED_ORIGINS = [
    "http://192.168.50.1",
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:3000",
    "http://localhost:5173",
    None,  # Allow direct / non-browser client connections
]
