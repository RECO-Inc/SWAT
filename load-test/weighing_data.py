#!/usr/bin/env python3
"""Generate virtual weighing data from a CSV profile and send it to the SWAT API."""

from __future__ import annotations

import argparse
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = Path(__file__).resolve().parent / "data" / "weighing_profile.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate and send virtual weighing data.")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="Generate virtual weighing JSON records.")
    gen.add_argument("--count", type=int, default=10, help="Number of records to generate.")
    gen.add_argument("--profile", default=str(DEFAULT_PROFILE), help="Profile JSON path.")
    gen.add_argument("--seed", type=int, default=0, help="Random seed. 0 uses current time.")
    gen.add_argument("--output", default="", help="Write generated payload JSON to this file.")

    send = sub.add_parser("send", help="Send generated or saved payload to the API.")
    send.add_argument("--url", default="http://localhost:8080", help="API base URL.")
    send.add_argument("--input", required=True, help="Input JSON file with items or a single request.")
    send.add_argument("--mode", choices=("single", "bulk"), default="bulk")
    send.add_argument("--test-run-id", default="CERT-WEIGHING-DATA-001")
    send.add_argument("--device-id", default="python-weighing")
    send.add_argument("--client-type", default="python")
    send.add_argument("--output", default="", help="Write API response JSON to this file.")

    run = sub.add_parser("run", help="Generate, send, and write before/after comparison files.")
    run.add_argument("--count", type=int, default=10)
    run.add_argument("--profile", default=str(DEFAULT_PROFILE))
    run.add_argument("--url", default="http://localhost:8080")
    run.add_argument("--mode", choices=("single", "bulk"), default="bulk")
    run.add_argument("--test-run-id", default="CERT-WEIGHING-DATA-001")
    run.add_argument("--device-id", default="python-weighing")
    run.add_argument("--client-type", default="python")
    run.add_argument("--output-dir", default="load-test/out", help="Directory for generated/response/comparison files.")
    run.add_argument("--seed", type=int, default=0)

    fetch = sub.add_parser("fetch", help="Fetch stored weighing records from the API.")
    fetch.add_argument("--url", default="http://localhost:8080")
    fetch.add_argument("--test-run-id", default="")
    fetch.add_argument("--ticket-id", default="")
    fetch.add_argument("--limit", type=int, default=500)
    fetch.add_argument("--output", default="", help="Write fetched records JSON to this file.")

    return parser.parse_args()


def load_profile(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def pick_weight(profile: dict[str, Any], key: str) -> int:
    stats = profile[key]
    low = max(1, int(stats["min"]))
    high = max(low, int(stats["max"]))
    avg = int(stats["avg"])
    value = int(random.gauss(avg, (high - low) / 6))
    return max(low, min(high, value))


def random_time_pair(now: datetime) -> tuple[str, str, str, str]:
    first = now - timedelta(minutes=random.randint(20, 90))
    second = first + timedelta(minutes=random.randint(8, 35))
    return (
        first.strftime("%Y-%m-%d"),
        first.strftime("%H:%M:%S"),
        second.strftime("%Y-%m-%d"),
        second.strftime("%H:%M:%S"),
    )


def build_source(profile: dict[str, Any], index: int) -> dict[str, Any]:
    business = random.choice(profile["businesses"])
    product_choices = profile.get("businessProducts", {}).get(business) or profile["products"]
    product = random.choice(product_choices)
    area = random.choice(profile["areas"])
    car = random.choice(profile["cars"])
    in_out = random.choices(profile["inOuts"], weights=[3, 1] if len(profile["inOuts"]) >= 2 else None)[0]

    weight_first = pick_weight(profile, "weightFirst")
    weight_second = pick_weight(profile, "weightSecond")
    if weight_second >= weight_first:
        weight_second = max(1000, weight_first - random.randint(500, 8000))
    weight_gap = weight_first - weight_second

    date_first, time_first, date_second, time_second = random_time_pair(datetime.now())
    slip_num = random.randint(1, 99999)
    card_key_id = random.randint(10000, 99999)

    return {
        "num": 900000 + index,
        "business": business,
        "car": car,
        "product": product,
        "area": area,
        "dateFirst": date_first,
        "timeFirst": time_first,
        "dateSecond": date_second,
        "timeSecond": time_second,
        "weightFirst": weight_first,
        "weightSecond": weight_second,
        "weightGap": weight_gap,
        "inOut": in_out,
        "unit": 0,
        "sumMoney": 0,
        "slipNum": slip_num,
        "cardKeyId": card_key_id,
        "userName": "",
        "carName": "",
        "note": "",
        "chargeFlag": "N",
        "chargeMoney": 0,
        "countReWrite": 0,
        "generated": True,
        "sourceFile": profile.get("sourceFile", ""),
    }


def source_to_request(source: dict[str, Any]) -> dict[str, Any]:
    ticket_id = f"SLIP-{source['slipNum']}-{source['num']}"
    return {
        "ticketId": ticket_id,
        "vehicleNo": str(source["car"]),
        "grossWeightKg": int(source["weightFirst"]),
        "tareWeightKg": int(source["weightSecond"]),
        "source": source,
    }


def generate_payload(profile_path: Path, count: int, seed: int) -> dict[str, Any]:
    if seed:
        random.seed(seed)
    else:
        random.seed(int(time.time()))

    profile = load_profile(profile_path)
    items = [source_to_request(build_source(profile, index + 1)) for index in range(count)]
    return {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "profile": str(profile_path),
        "count": count,
        "items": items,
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_payload(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "items" in data:
        return data
    if isinstance(data, dict) and "ticketId" in data:
        return {"items": [data]}
    if isinstance(data, list):
        return {"items": data}
    raise ValueError("input JSON must be an item, items[], or {items:[]}")


def request_api(
    url: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    headers: dict[str, str],
) -> tuple[int, Any]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        data=payload,
        method=method,
        headers={
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if payload is not None else {}),
            **headers,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"error": raw}


def send_payload(
    url: str,
    payload: dict[str, Any],
    mode: str,
    headers: dict[str, str],
) -> tuple[int, Any]:
    items = payload["items"]
    if mode == "single":
        last_status = 0
        last_body: Any = {"responses": []}
        responses = []
        for index, item in enumerate(items, start=1):
            status, body = request_api(url, "POST", "/api/weighing-data", item, {
                **headers,
                "X-Test-Worker-Id": f"worker-{index:03d}",
                "X-Test-Request-Seq": f"{index:06d}",
            })
            last_status = status
            responses.append({"status": status, "body": body})
        last_body = {"mode": "single", "responses": responses}
        return last_status, last_body

    status, body = request_api(
        url,
        "POST",
        "/api/weighing-data/bulk",
        {"items": items},
        {
            **headers,
            "X-Test-Worker-Id": "worker-001",
            "X-Test-Request-Seq": "000001",
        },
    )
    return status, body


def build_comparison(generated: dict[str, Any], response: Any) -> dict[str, Any]:
    sent_items = generated.get("items", [])
    stored_items: list[dict[str, Any]] = []

    if isinstance(response, dict):
        if "item" in response:
            stored_items = [response["item"]]
        elif "items" in response:
            stored_items = response["items"]
        elif "responses" in response:
            for entry in response["responses"]:
                body = entry.get("body", {})
                if isinstance(body, dict) and "item" in body:
                    stored_items.append(body["item"])

    rows = []
    for index, sent in enumerate(sent_items):
        stored = stored_items[index] if index < len(stored_items) else None
        rows.append(
            {
                "index": index,
                "sent": sent,
                "stored": stored,
                "matched": bool(stored)
                and sent.get("ticketId") == stored.get("ticketId")
                and sent.get("grossWeightKg") == stored.get("grossWeightKg")
                and sent.get("tareWeightKg") == stored.get("tareWeightKg"),
            }
        )

    return {
        "generatedAt": generated.get("generatedAt"),
        "sentCount": len(sent_items),
        "storedCount": len(stored_items),
        "matchedCount": sum(1 for row in rows if row["matched"]),
        "rows": rows,
    }


def command_generate(args: argparse.Namespace) -> int:
    payload = generate_payload(Path(args.profile), args.count, args.seed)
    if args.output:
        write_json(Path(args.output), payload)
        print(f"wrote {args.output}")
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def command_send(args: argparse.Namespace) -> int:
    payload = read_payload(Path(args.input))
    headers = {
        "X-Test-Run-Id": args.test_run_id,
        "X-Test-Client-Type": args.client_type,
        "X-Test-Device-Id": args.device_id,
    }
    status, body = send_payload(args.url, payload, args.mode, headers)
    result = {"status": status, "response": body}
    if args.output:
        write_json(Path(args.output), result)
        print(f"wrote {args.output} (HTTP {status})")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if 200 <= status < 300 else 1


def command_run(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    generated_path = output_dir / f"weighing_generated_{stamp}.json"
    response_path = output_dir / f"weighing_response_{stamp}.json"
    comparison_path = output_dir / f"weighing_comparison_{stamp}.json"

    generated = generate_payload(Path(args.profile), args.count, args.seed)
    write_json(generated_path, generated)

    headers = {
        "X-Test-Run-Id": args.test_run_id,
        "X-Test-Client-Type": args.client_type,
        "X-Test-Device-Id": args.device_id,
    }
    status, body = send_payload(args.url, generated, args.mode, headers)
    response_doc = {"status": status, "response": body}
    write_json(response_path, response_doc)

    comparison = build_comparison(generated, body)
    write_json(comparison_path, comparison)

    print(f"generated: {generated_path}")
    print(f"response:  {response_path}")
    print(f"compare:   {comparison_path}")
    print(f"HTTP {status}, matched {comparison['matchedCount']}/{comparison['sentCount']}")
    return 0 if 200 <= status < 300 else 1


def command_fetch(args: argparse.Namespace) -> int:
    query = []
    if args.test_run_id:
        query.append(f"testRunId={urllib.parse.quote(args.test_run_id)}")
    if args.ticket_id:
        query.append(f"ticketId={urllib.parse.quote(args.ticket_id)}")
    if args.limit:
        query.append(f"limit={args.limit}")
    path = "/api/weighing-data"
    if query:
        path += "?" + "&".join(query)

    status, body = request_api(args.url, "GET", path, None, {})
    if args.output:
        write_json(Path(args.output), {"status": status, "body": body})
        print(f"wrote {args.output} (HTTP {status})")
    else:
        print(json.dumps({"status": status, "body": body}, ensure_ascii=False, indent=2))
    return 0 if 200 <= status < 300 else 1


def main() -> int:
    args = parse_args()
    if args.command == "generate":
        return command_generate(args)
    if args.command == "send":
        return command_send(args)
    if args.command == "run":
        return command_run(args)
    if args.command == "fetch":
        return command_fetch(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
