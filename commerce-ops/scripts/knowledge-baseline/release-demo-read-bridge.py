"""Read-only production catalog bridge; run on the deployment host via SSH.

Only shopper_read capabilities are minted, remain in host memory, and authorize
the three fixed catalog reads below. No chat, customer, cart, or DB writes.
"""

import base64
import json
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import UTC, datetime

STORES = {"grocery", "jewelry", "electronics", "pharmacy"}
TOOLS = {"get_catalog_schema", "search_products", "get_product"}
metadata = {}


def inspect(name):
    return json.loads(subprocess.check_output(["docker", "inspect", name]))[0]


def encoded(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=")


def read(request):
    store, tool = request["store"], request["name"]
    if store not in STORES or tool not in TOOLS:
        raise ValueError("Only known demo catalog reads are admitted")
    if store not in metadata:
        gateway = inspect(f"rocento-{store}-api-gateway-1")
        config = dict(row.split("=", 1) for row in gateway["Config"]["Env"])
        key = next(
            row["Source"] for row in gateway["Mounts"]
            if row["Destination"] == config["ASSISTANT_PRIVATE_KEY_FILE"]
        )
        proxy = inspect(f"rocento-{store}-assistant-tools-1")
        ip = next(row["IPAddress"] for row in proxy["NetworkSettings"]["Networks"].values())
        area_request = urllib.request.Request(
            f"https://{store}.rocento.com/api/v1/delivery-areas",
            headers={"X-Commerce-Request": "1", "Origin": f"https://{store}.rocento.com", "User-Agent": "Rocento-Authorized-Release-Validation/1.0"},
        )
        with urllib.request.urlopen(area_request, timeout=20) as response:
            areas = json.load(response)
        area = next((row for row in areas if "Nasr City" in row["name"]), areas[0] if areas else None)
        metadata[store] = {"tenant": config["ASSISTANT_TENANT_ID"], "key": key, "ip": ip, "area": area}
    info = metadata[store]
    now = int(time.time())
    claims = {
        "iss": "commerce-assistant", "aud": "assistant-tools", "tenant": info["tenant"],
        "sub": None, "sid": None, "request_id": str(uuid.uuid4()),
        "iat": now, "exp": now + 45, "scope": "shopper_read",
    }
    signing = encoded(b'{"alg":"RS256","typ":"JWT"}') + b"." + encoded(json.dumps(claims).encode())
    signature = subprocess.check_output(
        ["openssl", "dgst", "-sha256", "-sign", info["key"]], input=signing,
    )
    token = (signing + b"." + encoded(signature)).decode()
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json", "X-Commerce-Request": "1"}
    if info["area"]:
        headers.update({"x-delivery-latitude": str(info["area"]["center_lat"]), "x-delivery-longitude": str(info["area"]["center_lng"])})
    body = json.dumps({"name": tool, "arguments": request["arguments"]}).encode()
    if len(body) > 16384:
        raise ValueError("Request exceeds bounded tool body")
    endpoint = f"http://{info['ip']}:8081/v1/assistant-tools/shopper"
    started = time.monotonic()
    with urllib.request.urlopen(urllib.request.Request(endpoint, data=body, headers=headers), timeout=15) as response:
        raw = response.read(131073)
        if len(raw) > 131072:
            raise ValueError("Response exceeds catalog bound")
        result = json.loads(raw)
        return {"store": store, "tenant": info["tenant"], "area": info["area"], "request": request,
                "capturedAt": datetime.now(UTC).isoformat(), "httpStatus": response.status,
                "elapsedMs": round((time.monotonic() - started) * 1000), "response": result}


for number, line in enumerate(sys.stdin, 1):
    if number > 60:
        raise RuntimeError("Catalog capture limit reached")
    try:
        result = read(json.loads(line))
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError) as error:
        # Never serialize request headers, capabilities, or secret contents.
        result = {"error": type(error).__name__, "message": str(error)[:300]}
    print(json.dumps(result), flush=True)
