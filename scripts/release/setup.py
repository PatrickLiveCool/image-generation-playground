"""Generate narrowly scoped, non-secret COS policies for this application."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

PREFIX = "qintopia-image/releases/"
FILES = ("app.tar.gz", "manifest.json", "SHA256SUMS", "sbom.spdx.json", "deployed.json")
MULTIPART_ACTIONS = (
    "name/cos:InitiateMultipartUpload",
    "name/cos:ListMultipartUploads",
    "name/cos:ListParts",
    "name/cos:UploadPart",
    "name/cos:CompleteMultipartUpload",
    "name/cos:AbortMultipartUpload",
)
MULTIPART_BUCKET_ACTIONS = ("name/cos:ListMultipartUploads",)
MULTIPART_OBJECT_ACTIONS = tuple(action for action in MULTIPART_ACTIONS if action not in MULTIPART_BUCKET_ACTIONS)


def policies(bucket: str, region: str) -> dict:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}-[0-9]{5,20}", bucket):
        raise ValueError("bucket must include its APPID")
    if not re.fullmatch(r"[a-z]{2}-[a-z]+(?:-[a-z]+)?(?:-[0-9]+)?", region):
        raise ValueError("invalid COS region")
    appid = bucket.rsplit("-", 1)[1]
    bucket_resource = f"qcs::cos:{region}:uid/{appid}:{bucket}/*"
    objects = f"qcs::cos:{region}:uid/{appid}:{bucket}/{PREFIX}*"
    result = {}
    for role in ("upload", "reader", "retention"):
        statements = [{"effect": "allow", "action": ["name/cos:GetObject", "name/cos:HeadObject"],
                       "resource": [objects + "/" + name for name in FILES]}]
        statements.append({"effect": "allow", "action": ["name/cos:GetBucketVersioning"], "resource": [bucket_resource]})
        statements.append({"effect": "allow", "action": ["name/cos:GetBucket"], "resource": [bucket_resource],
                           "condition": {"string_like": {"cos:prefix": ["qintopia-image%2Freleases%2F*"]}}})
        if role == "upload":
            statements.append({"effect": "allow", "action": ["name/cos:ListMultipartUploads"], "resource": [bucket_resource],
                               "condition": {"string_like": {"cos:prefix": ["qintopia-image%2Freleases%2F*"]}}})
            statements.append({"effect": "allow", "action": ["name/cos:PutObject", *MULTIPART_OBJECT_ACTIONS],
                               "resource": [objects + "/" + name for name in FILES]})
        elif role == "retention":
            statements.append({"effect": "allow", "action": ["name/cos:DeleteObject"], "resource": [objects + "/" + name for name in FILES]})
        result[role] = {"version": "2.0", "statement": statements}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    documents = policies(args.bucket, args.region)
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    for role, policy in documents.items():
        (args.output / f"cam-{role}.json").write_text(json.dumps(policy, indent=2) + "\n")
    print("Three scoped policy files created; no cloud operation was performed.")


if __name__ == "__main__":
    main()
