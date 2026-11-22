import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings


def _get_master_key() -> bytes:
    """Derives a 256-bit AES key from INTEGRATION_ENCRYPTION_KEY (falls back to SECRET_KEY for legacy data)."""
    raw_key = getattr(settings, "INTEGRATION_ENCRYPTION_KEY", "") or settings.SECRET_KEY
    return hashlib.sha256(raw_key.encode("utf-8")).digest()


def encrypt_credentials(data: dict) -> bytes:
    """Encrypts a credentials dict into AES-256-GCM ciphertext."""
    if not data:
        return b""
    key = _get_master_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)  # 96-bit nonce for AES-GCM
    json_bytes = json.dumps(data).encode("utf-8")
    ciphertext = aesgcm.encrypt(nonce, json_bytes, None)
    # Pack: nonce (12 bytes) + ciphertext (includes 16-byte tag)
    return nonce + ciphertext


def decrypt_credentials(encrypted_bytes: bytes) -> dict:
    """Decrypts AES-256-GCM ciphertext back into a dictionary."""
    if not encrypted_bytes:
        return {}
    key = _get_master_key()
    aesgcm = AESGCM(key)
    nonce = encrypted_bytes[:12]
    ciphertext = encrypted_bytes[12:]
    decrypted_bytes = aesgcm.decrypt(nonce, ciphertext, None)
    return json.loads(decrypted_bytes.decode("utf-8"))
