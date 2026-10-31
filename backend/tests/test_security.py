import pytest
from cryptography.exceptions import InvalidTag

from backend.core.config import get_settings
from backend.core.security import (
    decrypt_replay,
    encrypt_replay,
    generate_management_token,
    generate_short_code,
    hash_management_token,
    sha256,
    verify_management_token,
)


@pytest.fixture(autouse=True)
def _secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SECRET_KEY", "Tj5I2o7uKkc0jSJsTXb3RxfYpD9dKa/Tb3V0hqmeXiM=")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_codes_are_base62_five_chars() -> None:
    codes = {generate_short_code() for _ in range(50)}
    assert len(codes) == 50
    assert all(len(code) == 5 for code in codes)
    assert all(code.isascii() and code.isalnum() for code in codes)


def test_token_hash_roundtrip() -> None:
    token = generate_management_token()
    digest = hash_management_token(token)
    assert len(digest) == 32
    assert verify_management_token(token, digest)
    assert not verify_management_token(token + "x", digest)


def test_replay_encryption_roundtrip_and_tamper() -> None:
    data = b'{"short_code":"abc"}'
    aad = sha256(b"key") + sha256(b"body")
    payload = encrypt_replay(data, aad)
    assert decrypt_replay(payload, aad) == data

    with pytest.raises(InvalidTag):
        decrypt_replay(payload, sha256(b"other") + sha256(b"body"))

    tampered = payload[:-1] + bytes([payload[-1] ^ 1])
    with pytest.raises(InvalidTag):
        decrypt_replay(tampered, aad)
