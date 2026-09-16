import logging
import os
import re
from typing import Dict, List, Optional, Tuple

import requests
from config import WHISPER_TIMEOUT_SECS, WHISPER_URL

logger = logging.getLogger("reliv_voice.whisper")


class WhisperClient:
    """
    Local-only whisper.cpp client. Captured customer audio never leaves the kiosk.
    """

    def __init__(self, endpoint_url: str = WHISPER_URL, timeout_secs: int = WHISPER_TIMEOUT_SECS):
        self.endpoint_url = endpoint_url
        self.timeout_secs = timeout_secs

    def build_prompt(self, base_prompt: str, vocabulary_hints: Optional[List[str]], lang: str = "auto") -> str:
        # Script-specific anchor so Whisper is never confused by competing alphabets:
        norm = (lang or "auto").lower()
        if norm.startswith("hi"):
            kiosk_anchor = (
                "डॉक्टर, दवाई, पर्चा, पेमेंट, हाँ, नहीं, हो गया, क्या करना है, सहायता, "
                "doctor, medicine, payment, yes, no, done, cancel, help"
            )
        elif norm.startswith("bn"):
            kiosk_anchor = (
                "ডাক্তার, ওষুধ, প্রেসক্রিপশন, পেমেন্ট, হ্যাঁ, না, কী করতে হবে, কী করব, সাহায্য, "
                "doctor, medicine, payment, yes, no, done, cancel, help"
            )
        else:
            kiosk_anchor = (
                "doctor, medicine, consultation, payment, done, yes, no, cancel, confirm, "
                "kya karna hai, ho gaya, haan, nahi, ki korte hobe, ki korbo, help"
            )

        parts = [kiosk_anchor]
        if base_prompt:
            parts.append(base_prompt.strip())
        if vocabulary_hints:
            cleaned_hints = [h.strip() for h in vocabulary_hints if h and isinstance(h, str)]
            if cleaned_hints:
                parts.append("Hints: " + ", ".join(cleaned_hints))

        combined = " ".join(parts).strip()
        return combined[:400]

    def transcribe(
        self,
        wav_path: str,
        language: str = "auto",
        prompt: str = "",
        vocabulary_hints: Optional[List[str]] = None,
    ) -> Tuple[str, float, str]:
        normalized_lang = str(language).lower().split("-")[0]
        if normalized_lang not in {"en", "hi", "bn"}:
            normalized_lang = "auto"
        used_lang = normalized_lang
        final_prompt = self.build_prompt(prompt, vocabulary_hints, normalized_lang)

        form_data = {
            "temperature": "0.0",
            "temperature_inc": "0.0",
            "response_format": "json",
            "token_timestamps": "false",
            "beam_size": "1",
            "best_of": "1",
        }
        # whisper.cpp: only pass language if explicit; if auto, leave empty or 'auto'
        if normalized_lang != "auto":
            form_data["language"] = normalized_lang
        else:
            form_data["language"] = "auto"

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
            detected = str(data.get("language") or normalized_lang).lower()
            used_lang = {"english": "en", "hindi": "hi", "bengali": "bn"}.get(detected, detected)
            if used_lang not in {"en", "hi", "bn"}:
                used_lang = normalized_lang


        except (requests.RequestException, ValueError) as exc:
            logger.warning("Local Whisper unavailable: %s", exc)
            return ("", 0.0, used_lang)

        # Very smart filtering of fake/noise transcripts and Whisper hallucinations
        if text:
            # 1. Strip all noise tags: [], (), **, <>
            text = re.sub(r"\[.*?\]", "", text)
            text = re.sub(r"\(.*?\)", "", text)
            text = re.sub(r"\*.*?\*", "", text)
            text = re.sub(r"<.*?>", "", text)
            text = text.strip()

            # 2. Collapse repetitive phrase / word loops (e.g. "haa, haa, haa..." -> "haa")
            text = re.sub(r"(\b\w+\b)(?:[,\s]+\1\b){2,}", r"\1", text, flags=re.IGNORECASE | re.UNICODE)
            # Collapse multi-character repeating sub-strings (e.g. "কাযে, কাযে, কাযে" -> "কাযে")
            text = re.sub(r"(.{2,15}?)(?:[,\s]*\1){3,}", r"\1", text, flags=re.UNICODE)
            text = text.strip()

            # 3. Drop if text contains NO letters or numbers (pure symbols like "...", "---", "?!")
            if not re.search(r"[a-zA-Z0-9ऀ-ॿঀ-৿]", text):
                text = ""

            # 4. Filter common Whisper hallucinations when there is background noise
            lower_clean = re.sub(r"[^a-z]", "", text.lower())
            hallucinations = [
                "thankyou", "thanksforwatching", "subscribe", "subscribetomychannel", 
                "amaraorg", "by", "you", "it", "music", "silence", "laughs", "sighs", 
                "bell", "birds", "birdschirping", "mimics", "subtitle", "subtitles", "transcribed", "translated", "closedcaptions", "caption", "copyright"
            ]
            if lower_clean in hallucinations:
                text = ""

            # 5. Normalize common colloquial / accent variations for kiosk actions:
            colloquial_map = [
                (r"\b(be\s*mean|pimin|bimin)\s*done\b", "payment done"),
                (r"\b(hogia|hogya|ho\s*gya)\b", "ho gaya"),
                (r"\b(ha|haa|haye)\b", "haan"),
                (r"\b(kya\s*karna\s*h)\b", "kya karna hai"),
                (r"\b(ki\s*korte\s*hobe|ki\s*korbo)\b", "কী করতে হবে"),
                (r"\b(taka\s*deya\s*hoyeche|payment\s*hoyeche)\b", "পেমেন্ট হয়েছে"),
            ]
            for pattern, replacement in colloquial_map:
                text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

        if not text:
            confidence = 0.0
        elif len(text) < 3:
            confidence = 0.5

        return (text, confidence, used_lang)
