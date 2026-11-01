import base64
import hashlib
import hmac
import os
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from backend.core.config import get_settings

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
TOKEN_PREFIX = "shrm_"
SESSION_PREFIX = "shrs_"
INVITATION_PREFIX = "shri_"
TOKEN_BYTES = 32  # 256-bit management token
SHORT_CODE_LENGTH = 5

# OWASP's Argon2id baseline (19 MiB, 2 passes, 1 lane). Hashes made with
# other parameters still verify and are upgraded on the next sign-in.
_PASSWORDS = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
# Computed on first use so a cold start does not pay for a full hash.
_dummy_hash: str | None = None


def _derive(purpose: bytes) -> bytes:
    settings = get_settings()
    secret = base64.b64decode(settings.secret_key)
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=purpose,
    ).derive(secret)


def _pepper() -> bytes:
    return _derive(b"management-token-hmac-v1")


def _replay_key() -> bytes:
    return _derive(b"idempotency-replay-aead-v1")


def generate_short_code(length: int = SHORT_CODE_LENGTH) -> str:
    return "".join(secrets.choice(BASE62) for _ in range(length))


def generate_management_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)


def hash_management_token(token: str) -> bytes:
    return hmac.new(_pepper(), token.encode(), hashlib.sha256).digest()


def verify_management_token(token: str, stored_hash: bytes) -> bool:
    return hmac.compare_digest(hash_management_token(token), stored_hash)


def generate_password_hash(password: str) -> str:
    return _PASSWORDS.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _PASSWORDS.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    try:
        return _PASSWORDS.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def verify_dummy_password(password: str) -> None:
    """Burn the same work as a real check so unknown emails are not faster."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = _PASSWORDS.hash("shortly-dummy-password")
    try:
        _PASSWORDS.verify(_dummy_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        pass


def generate_session_token() -> str:
    return SESSION_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)


def generate_invitation_token() -> str:
    return INVITATION_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)


def hash_opaque_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def encrypt_replay(plaintext: bytes, associated_data: bytes) -> bytes:
    # Format: 12-byte nonce || ciphertext+tag. Key version is implicit in v1.
    nonce = os.urandom(12)
    aesgcm = AESGCM(_replay_key())
    return nonce + aesgcm.encrypt(nonce, plaintext, associated_data)


def decrypt_replay(payload: bytes, associated_data: bytes) -> bytes:
    nonce, ciphertext = payload[:12], payload[12:]
    aesgcm = AESGCM(_replay_key())
    return aesgcm.decrypt(nonce, ciphertext, associated_data)


def link_password_fingerprint(password: str) -> str:
    """Keyed digest for idempotency fingerprints; a plain hash would be guessable."""
    key = _derive(b"link-password-fingerprint-v1")
    return hmac.new(key, password.encode(), hashlib.sha256).hexdigest()


def link_password_tag(password_hash: str) -> str:
    """Stands in for the Argon2 hash in the redirect cache and unlock cookies.

    It changes whenever the password does, so old unlock cookies stop working.
    """
    key = _derive(b"link-password-tag-v1")
    return hmac.new(key, password_hash.encode(), hashlib.sha256).hexdigest()[:32]


def _unlock_mac(code: str, tag: str, expires: int) -> str:
    key = _derive(b"link-unlock-cookie-v1")
    message = f"{code}\x00{tag}\x00{expires}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def link_unlock_token(code: str, tag: str, expires: int) -> str:
    return f"{expires}.{_unlock_mac(code, tag, expires)}"


def verify_link_unlock(token: str | None, code: str, tag: str, now: int) -> bool:
    if not token:
        return False
    expires_text, _, mac = token.partition(".")
    if not expires_text.isdigit() or int(expires_text) <= now:
        return False
    return hmac.compare_digest(mac, _unlock_mac(code, tag, int(expires_text)))
