import logging
import os
import re
from typing import Dict, List, Optional, Tuple

import requests
from config import WHISPER_TIMEOUT_SECS, WHISPER_URL

logger = logging.getLogger("reliv_voice.whisper")


class WhisperClient:
    """
    Client for the local whisper.cpp server, with a fallback to Google Free API
    for local testing on Windows laptops when the Whisper server isn't running.
    """

    def __init__(self, endpoint_url: str = WHISPER_URL, timeout_secs: int = WHISPER_TIMEOUT_SECS):
        self.endpoint_url = endpoint_url
        self.timeout_secs = timeout_secs

    def build_prompt(self, base_prompt: str, vocabulary_hints: Optional[List[str]]) -> str:
        parts = []
        if base_prompt:
            parts.append(base_prompt.strip())
        if vocabulary_hints:
            cleaned_hints = [h.strip() for h in vocabulary_hints if h and isinstance(h, str)]
            if cleaned_hints:
                parts.append("Keywords: " + ", ".join(cleaned_hints))

        combined = " ".join(parts).strip()
        return combined[:1200]

    def transcribe(
        self,
        wav_path: str,
        language: str = "auto",
        prompt: str = "",
        vocabulary_hints: Optional[List[str]] = None,
    ) -> Tuple[str, float, str]:
        normalized_lang = language.lower() if language in {"en", "hi", "bn"} else "auto"
        final_prompt = self.build_prompt(prompt, vocabulary_hints)

        form_data = {
            "temperature": "0.0",
            "temperature_inc": "0.0",
            "response_format": "json",
            "token_timestamps": "false",
            "language": normalized_lang,
        }
        if final_prompt:
            form_data["prompt"] = final_prompt
            form_data["carry_initial_prompt"] = "true"

        text = ""
        confidence = 0.85

        try:
            with open(wav_path, "rb") as fh:
                res = requests.post(
                    self.endpoint_url,
                    files={"file": ("utterance.wav", fh, "audio/wav")},
                    data=form_data,
                    timeout=self.timeout_secs,
                )
            res.raise_for_status()
            data = res.json()
            text = str(data.get("text") or "").strip()

            if not text and normalized_lang != "auto":
                form_data["language"] = "auto"
                with open(wav_path, "rb") as fh:
                    res = requests.post(
                        self.endpoint_url,
                        files={"file": ("utterance.wav", fh, "audio/wav")},
                        data=form_data,
                        timeout=self.timeout_secs,
                    )
                res.raise_for_status()
                data = res.json()
                text = str(data.get("text") or "").strip()
                normalized_lang = "auto"

        except requests.RequestException as exc:
            # We don't want to spam the user's console with connection refused errors on Windows
            # when they are just testing without the Pi's Whisper server.
            try:
                import speech_recognition as sr
                r = sr.Recognizer()
                with sr.AudioFile(wav_path) as source:
                    audio = r.record(source)
                
                # Map language to Google API format
                google_lang = "en-IN"
                if normalized_lang == "hi":
                    google_lang = "hi-IN"
                elif normalized_lang == "bn":
                    google_lang = "bn-IN"
                    
                text = r.recognize_google(audio, language=google_lang)
                logger.info(f"Google Fallback Transcribed: {text}")
            except sr.UnknownValueError:
                # Normal when there is background noise but no speech
                text = ""
            except sr.RequestError as e:
                logger.error(f"Google Fallback API unavailable: {e}")
                text = ""
            except ImportError:
                logger.error("speech_recognition module not installed. Please run: pip install SpeechRecognition")
                text = ""
            except Exception as e:
                logger.debug(f"Google Fallback failed: {e}")
                text = ""

        # Very smart filtering of fake/noise transcripts and Whisper hallucinations
        if text:
            # 1. Strip brackets and parentheses (Whisper tags for noise)
            text = re.sub(r"\[.*?\]", "", text)
            text = re.sub(r"\(.*?\)", "", text)
            text = text.strip()
            
            # 2. Drop if text contains NO letters or numbers (pure symbols like "...", "---", "?!")
            # Checking against Latin, Devanagari (Hindi), and Bengali unicode blocks
            if not re.search(r"[a-zA-Z0-9ऀ-ॿঀ-৿]", text):
                text = ""
            
            # 3. Filter common Whisper hallucinations when there is background noise
            lower_clean = re.sub(r"[^a-z]", "", text.lower())
            hallucinations = ["thankyou", "thanksforwatching", "subscribe", "subscribetomychannel", "amaraorg", "by"]
            if lower_clean in hallucinations:
                text = ""

        if not text:
            confidence = 0.0
        elif len(text) < 3:
            confidence = 0.5

        return (text, confidence, normalized_lang)
