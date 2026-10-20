import http.client
import json
import re
import ssl
import sys
import time
from urllib.parse import urlsplit


def request(value, proxy=("172.31.240.1", 4794), tls_context=None):
    if not isinstance(value, dict) or set(value) - {"tool", "url", "query", "grant", "expiresAt"}:
        raise ValueError("Invalid network step")
    url = urlsplit(value["url"])
    remaining = value["expiresAt"] / 1000 - time.time()
    if (value["tool"] not in ("webfetch", "websearch") or not 0 < remaining <= 120
            or not re.fullmatch(r"[a-f0-9]{64}", value["grant"])
            or url.scheme not in ("http", "https") or not url.hostname
            or url.username or url.password or url.port or url.fragment):
        raise ValueError("Network step denied")
    headers = {"User-Agent": "SciKeel/1", "Accept": "text/*, application/json, application/xml"}
    method, body = "GET", None
    if value["tool"] == "websearch":
        if value["url"] != "https://search.parallel.ai/mcp" or not isinstance(value.get("query"), str) or not value["query"].strip() or len(value["query"]) > 4096:
            raise ValueError("Search denied")
        method = "POST"
        headers.update({"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "web_search", "arguments": {"objective": value["query"]}}}).encode()
    elif "query" in value:
        raise ValueError("Unexpected fetch input")
    auth = {"Proxy-Authorization": "Bearer " + value["grant"]}
    if url.scheme == "https":
        connection = http.client.HTTPSConnection(*proxy, timeout=remaining, context=tls_context or ssl.create_default_context())
        connection.set_tunnel(url.hostname, 443, headers=auth)
        target = (url.path or "/") + ("?" + url.query if url.query else "")
    else:
        connection = http.client.HTTPConnection(*proxy, timeout=remaining)
        headers.update(auth)
        headers["Host"] = url.netloc
        target = value["url"]
    try:
        connection.request(method, target, body=body, headers=headers)
        response = connection.getresponse()
        raw = bytearray()
        while len(raw) <= 128 * 1024:
            remaining = value["expiresAt"] / 1000 - time.time()
            if remaining <= 0:
                raise TimeoutError("Network deadline")
            if connection.sock:
                connection.sock.settimeout(remaining)
            chunk = response.read1(min(32768, 128 * 1024 + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        text = raw.decode("utf-8", errors="replace")
        location = response.getheader("Location", "")
        if len(location) > 2048:
            raise ValueError("Redirect limit")
        return {"status": response.status, "contentType": response.getheader("Content-Type", "")[:256],
                "location": location, "text": text[:32768], "truncated": len(raw) > 128 * 1024 or len(text) > 32768}
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("Input limit")
        print(json.dumps(request(json.loads(raw)), ensure_ascii=False))
    except Exception:
        print(json.dumps({"error": {"code": "native_network_failed"}}))
