#!/usr/bin/env python3
"""Upload a sample weighing slip image with concurrent logical workers."""

from __future__ import annotations

import argparse
import http.client
import json
import statistics
import threading
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IMAGE_PATH = REPO_ROOT / "sample" / "84b42905c32037.jpg"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run multipart image upload load tests against the SWAT API."
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8080",
        help="Base URL for HAProxy or API server. Example: http://172.16.0.90:8080",
    )
    parser.add_argument(
        "--image",
        default=str(DEFAULT_IMAGE_PATH),
        help="Path to the sample image file.",
    )
    parser.add_argument("--workers", type=int, default=100, help="Logical worker count.")
    parser.add_argument("--duration", type=float, default=10.0, help="Test duration in seconds.")
    parser.add_argument(
        "--rate-per-worker",
        type=float,
        default=0.0,
        help="Requests per second for each worker. Use 0 for max throughput.",
    )
    parser.add_argument(
        "--test-run-id",
        default="CERT-LOCAL-IMAGE-LOAD-001",
        help="Value for X-Test-Run-Id.",
    )
    parser.add_argument("--device-id", default="local", help="Value for X-Test-Device-Id.")
    parser.add_argument(
        "--client-type",
        default="python-load",
        help="Value for X-Test-Client-Type.",
    )
    return parser.parse_args()


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0

    sorted_values = sorted(values)
    idx = min(len(sorted_values) - 1, int((p / 100) * len(sorted_values)))
    return sorted_values[idx]


def build_multipart_body(image_path: Path) -> tuple[bytes, str]:
    image = image_path.read_bytes()
    boundary = "----swatboundary"
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{image_path.name}"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()

    return prefix + image + suffix, boundary


def create_connection(parsed_url) -> http.client.HTTPConnection:
    if parsed_url.scheme == "https":
        return http.client.HTTPSConnection(parsed_url.hostname, parsed_url.port or 443, timeout=10)

    return http.client.HTTPConnection(parsed_url.hostname, parsed_url.port or 80, timeout=10)


def resolve_image_path(image_arg: str) -> Path:
    raw_path = Path(image_arg).expanduser()
    candidates = []

    if raw_path.is_absolute():
        candidates.append(raw_path)
    else:
        candidates.append(Path.cwd() / raw_path)
        candidates.append(REPO_ROOT / raw_path)
        candidates.append(REPO_ROOT / "sample" / raw_path)

    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()

    checked = "\n".join(f"- {candidate}" for candidate in candidates)
    raise FileNotFoundError(f"image file not found. Checked:\n{checked}")


def run_load_test(args: argparse.Namespace) -> dict:
    image_path = resolve_image_path(args.image)
    body, boundary = build_multipart_body(image_path)
    parsed_url = urlparse(args.url.rstrip("/"))
    upload_path = "/api/weighing-slip/upload"

    if parsed_url.path:
        upload_path = parsed_url.path.rstrip("/") + upload_path

    barrier = threading.Barrier(args.workers + 1)
    stop_at = 0.0
    lock = threading.Lock()
    statuses: Counter[int] = Counter()
    backends: Counter[str] = Counter()
    latencies: list[float] = []
    errors: list[str] = []

    def worker(worker_idx: int) -> None:
        nonlocal stop_at

        barrier.wait()
        conn = create_connection(parsed_url)
        seq = 0
        next_allowed_at = time.perf_counter()

        while time.perf_counter() < stop_at:
            if args.rate_per_worker > 0:
                now = time.perf_counter()
                if now < next_allowed_at:
                    time.sleep(next_allowed_at - now)
                next_allowed_at += 1 / args.rate_per_worker

            seq += 1
            headers = {
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
                "X-Test-Run-Id": args.test_run_id,
                "X-Test-Client-Type": args.client_type,
                "X-Test-Device-Id": args.device_id,
                "X-Test-Worker-Id": f"worker-{worker_idx:03d}",
                "X-Test-Request-Seq": f"{seq:06d}",
            }

            started_at = time.perf_counter()
            try:
                conn.request("POST", upload_path, body=body, headers=headers)
                response = conn.getresponse()
                response.read()
                latency_ms = (time.perf_counter() - started_at) * 1000

                with lock:
                    statuses[response.status] += 1
                    backends[response.getheader("X-Backend-Server") or "unknown"] += 1
                    latencies.append(latency_ms)
            except Exception as exc:
                with lock:
                    errors.append(f"{type(exc).__name__}: {exc}")
                try:
                    conn.close()
                except Exception:
                    pass
                conn = create_connection(parsed_url)

        conn.close()

    threads = [threading.Thread(target=worker, args=(idx + 1,)) for idx in range(args.workers)]
    for thread in threads:
        thread.start()

    started_at = time.perf_counter()
    stop_at = started_at + args.duration
    barrier.wait()

    for thread in threads:
        thread.join()

    elapsed = time.perf_counter() - started_at
    total = sum(statuses.values())
    success = sum(count for status, count in statuses.items() if 200 <= status < 300)
    failed = total - success
    multipart_bytes = len(body)
    payload_mbps = (success * multipart_bytes * 8 / elapsed) / 1_000_000 if elapsed else 0.0

    return {
        "url": args.url,
        "upload_path": upload_path,
        "image": str(image_path),
        "image_size_bytes": image_path.stat().st_size,
        "multipart_body_bytes": multipart_bytes,
        "workers": args.workers,
        "rate_per_worker": args.rate_per_worker,
        "duration_sec": round(elapsed, 3),
        "total_requests": total,
        "success_requests": success,
        "failed_requests": failed,
        "success_tps": round(success / elapsed, 2) if elapsed else 0.0,
        "total_tps": round(total / elapsed, 2) if elapsed else 0.0,
        "payload_mbps": round(payload_mbps, 2),
        "latency_avg_ms": round(statistics.mean(latencies), 2) if latencies else 0.0,
        "latency_p95_ms": round(percentile(latencies, 95), 2),
        "latency_p99_ms": round(percentile(latencies, 99), 2),
        "status_counts": dict(sorted(statuses.items())),
        "backend_counts": dict(sorted(backends.items())),
        "error_count": len(errors),
        "errors_sample": errors[:5],
    }


def main() -> None:
    result = run_load_test(parse_args())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
