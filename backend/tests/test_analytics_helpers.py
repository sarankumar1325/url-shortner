from backend.services.analytics import classify_device, referer_origin


def test_bot_detection() -> None:
    assert classify_device("Mozilla/5.0 (compatible; Googlebot/2.1)") == ("bot", True)
    assert classify_device("curl/8.4.0") == ("bot", True)
    assert classify_device("SomePreviewBot/1.0") == ("bot", True)


def test_device_classification() -> None:
    assert classify_device("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")[0] == "mobile"
    assert classify_device("Mozilla/5.0 (iPad; CPU OS 17_0)")[0] == "tablet"
    assert (
        classify_device("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit")[0]
        == "desktop"
    )
    assert classify_device(None) == ("unknown", False)


def test_referer_origin() -> None:
    assert referer_origin("https://example.com/post?x=1#top") == "https://example.com"
    assert referer_origin("HTTP://Example.COM:8080/x") == "http://example.com:8080"
    assert referer_origin(None) is None
    assert referer_origin("not a url") is None
