"""Compare two regional COS public endpoints with disposable synthetic parts.

Never completes a multipart upload, writes a release object, or deploys anything.
Only multipart tasks created under a fresh diagnostic key may be aborted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import socket
import sys
import time
import uuid

from common import ReleaseError, release_prefix, require
from cos import CosStore, _error_fields

BUCKET = "qintopia-image-1305166808"
REGION = "ap-shanghai"
ENDPOINTS = {"regional": "cos.ap-shanghai.myqcloud.com", "regional_new_domain": "cos.ap-shanghai.tencentcos.cn"}
PART_BYTES = 2 * 1024 * 1024


def emit(value):
    print(json.dumps(value, sort_keys=True), flush=True)


def inspect_parts(client, key, upload_id):
    parts, marker = {}, 0
    for _ in range(10):
        result = client.list_parts(Bucket=BUCKET, Key=key, UploadId=upload_id, PartNumberMarker=marker)
        for part in result.get("Part", []):
            parts[int(part["PartNumber"])] = {"size": int(part["Size"]), "md5": part["ETag"].strip('"')}
        if str(result.get("IsTruncated", "false")).lower() != "true":
            return parts
        next_marker = int(result["NextPartNumberMarker"])
        require(next_marker > marker, "multipart pagination did not advance")
        marker = next_marker
    raise ReleaseError("diagnostic part listing exceeded its bound")


def probe(control, clients):
    revision = hashlib.sha256(uuid.uuid4().bytes).hexdigest()[:40]
    key = release_prefix("v0.0.0", revision) + "app.tar.gz"
    # A unique key, checked before initiation, isolates all cleanup from releases.
    existing = control.list_multipart_uploads(Bucket=BUCKET, Prefix=key)
    require(not existing.get("Upload"), "diagnostic key already has a multipart task")
    require(not control.list_objects(Bucket=BUCKET, Prefix=key).get("Contents"), "diagnostic key already has an object")
    report = {"key": key, "results": [], "cleanup": "pending", "completedObjectsCreated": 0}
    emit({"event": "probe_start", "key": key, "bytesPerLargePart": PART_BYTES, "retries": 0, "concurrency": 1})
    payloads = {64 * 1024: os.urandom(64 * 1024), PART_BYTES: os.urandom(PART_BYTES)}
    upload_id = None
    deadline = time.monotonic() + 360
    try:
        upload_id = control.create_multipart_upload(Bucket=BUCKET, Key=key, ACL="private", Metadata={"x-cos-forbid-overwrite": "true"})["UploadId"]
        number = 0
        for round_number, order in enumerate((list(clients), list(reversed(clients))), 1):
            for size, body in payloads.items():
                for label in order:
                    require(time.monotonic() < deadline - 120, "probe time budget reached; reserving time for cleanup")
                    number += 1
                    row = {"endpoint": label, "round": round_number, "part": number, "bytes": size}
                    emit({"event": "part_start", **row})
                    started = time.monotonic()
                    try:
                        response = clients[label].upload_part(Bucket=BUCKET, Key=key, Body=body, PartNumber=number, UploadId=upload_id, EnableMD5=True)
                        etag = next((value for name, value in response.items() if name.lower() == "etag"), "")
                        require(etag.strip('"') == hashlib.md5(body).hexdigest(), "diagnostic part checksum mismatch")
                        row["outcome"] = "verified"
                    except Exception as error:
                        row.update(outcome="failed", **_error_fields(error))
                    row["seconds"] = round(time.monotonic() - started, 3)
                    # Resolve uncertain acknowledgements by reading that exact part.
                    try:
                        parts = inspect_parts(control, key, upload_id)
                        row["storedAndVerified"] = parts.get(number) == {"size": size, "md5": hashlib.md5(body).hexdigest()}
                    except Exception as error:
                        row["storedAndVerified"] = None
                        row["inspectionError"] = _error_fields(error)
                    report["results"].append(row)
                    emit({"event": "part_result", **row})
    except Exception as error:
        report["failure"] = _error_fields(error)
    finally:
        # Reconcile an ambiguous initiation before deciding which task to abort.
        try:
            tasks = control.list_multipart_uploads(Bucket=BUCKET, Prefix=key).get("Upload", [])
            owned = {task["UploadId"] for task in tasks if task.get("Key") == key}
            if upload_id:
                owned.add(upload_id)
            require(upload_id is not None or owned, "initiation outcome is unknown; inspect diagnostic key before cleanup is considered confirmed")
            for task_id in owned:
                try:
                    control.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=task_id)
                except Exception as error:
                    if not (hasattr(error, "get_status_code") and error.get_status_code() == 404):
                        raise
            remaining = control.list_multipart_uploads(Bucket=BUCKET, Prefix=key).get("Upload", [])
            require(not any(task.get("Key") == key for task in remaining), "diagnostic multipart task is still present")
            require(not control.list_objects(Bucket=BUCKET, Prefix=key).get("Contents"), "unexpected completed diagnostic object")
            report["cleanup"] = "verified"
        except Exception as error:
            report["cleanup"] = "unconfirmed"
            report["cleanupError"] = _error_fields(error)
    emit({"event": "probe_complete", **report})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from qcloud_cos import CosConfig, CosS3Client
    import requests
    logger = logging.getLogger("qcloud_cos")
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False
    require(os.environ.get("COS_BUCKET") == BUCKET and os.environ.get("COS_REGION") == REGION, "unexpected diagnostic bucket or region")
    store = CosStore(role="upload")
    store._mutating()  # Verify bucket versioning before creating a temporary task.
    config = store._client().get_conf()
    clients, sessions = {}, []
    try:
        for label, endpoint in ENDPOINTS.items():
            host = BUCKET + "." + endpoint
            addresses = sorted({row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
            emit({"event": "endpoint", "label": label, "host": host, "addresses": addresses})
            session = requests.Session()
            sessions.append(session)
            endpoint_config = CosConfig(Region=REGION, SecretId=config._secret_id, SecretKey=config._secret_key, Token=config._token, Scheme="https", Endpoint=endpoint, Timeout=(30, 30))
            clients[label] = CosS3Client(endpoint_config, retry=0, session=session)
        control_session = requests.Session()
        sessions.append(control_session)
        control_config = CosConfig(Region=REGION, SecretId=config._secret_id, SecretKey=config._secret_key, Token=config._token, Scheme="https", Endpoint=ENDPOINTS["regional"], Timeout=(10, 15))
        report = probe(CosS3Client(control_config, retry=0, session=control_session), clients)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        return 0 if report["cleanup"] == "verified" and any(row.get("storedAndVerified") for row in report["results"]) else 1
    finally:
        for session in sessions:
            session.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        emit({"event": "probe_error", **_error_fields(error)})
        sys.exit(1)
