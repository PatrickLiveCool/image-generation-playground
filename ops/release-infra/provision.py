"""Provision isolated release CAM identities; never print or commit credentials."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / ".local-ops/release-infra"
spec = importlib.util.spec_from_file_location("image_release_setup", ROOT / "scripts/release/setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def read(name):
    path = PRIVATE / name
    return json.loads(path.read_text()) if path.exists() else {}


def save(name, value):
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = PRIVATE / name
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def provision(role, cloud):
    name = "qintopia-image-release-" + role
    state_file = role + "-identity.json"
    state = read(state_file)
    policy = setup.policies(cloud.BUCKET, cloud.REGION)[role]
    if state.get("pending"):
        raise RuntimeError("Prior identity operation requires reconciliation: " + role)
    if not state.get("uin"):
        try:
            cloud.call("cam", "GetUser", {"Name": name})
        except Exception as error:
            if getattr(error, "code", None) not in {"ResourceNotFound.UserNotExist", "InvalidParameter.UserNotExist", "ResourceNotFound.UserNotExists"}:
                raise
        else:
            raise RuntimeError("Existing identity requires explicit reconciliation: " + name)
        save(state_file, {"name": name, "pending": "AddUser"})
        user = cloud.call("cam", "AddUser", {"Name": name, "ConsoleLogin": 0, "UseApi": 0, "Remark": "QinTopia image release " + role})
        state = {"name": name, "uin": user["Uin"]}
        save(state_file, state)
    if not state.get("policy_id"):
        save(state_file, {**state, "pending": "CreatePolicy"})
        response = cloud.call("cam", "CreatePolicy", {"PolicyName": name + "-restricted", "PolicyDocument": json.dumps(policy), "Description": "Isolated qintopia-image/releases prefix"})
        state["policy_id"] = response["PolicyId"]
        save(state_file, state)
    actual = cloud.call("cam", "GetPolicy", {"PolicyId": state["policy_id"]})
    if json.loads(actual["PolicyDocument"]) != policy:
        raise RuntimeError("Policy differs from the reviewed scope: " + role)
    cloud.call("cam", "AttachUserPolicy", {"PolicyId": state["policy_id"], "AttachUin": state["uin"]})
    if not read(role + "-credentials.json"):
        save(state_file, {**state, "pending": "CreateAccessKey"})
        response = cloud.call("cam", "CreateAccessKey", {"TargetUin": state["uin"], "Description": "image-release." + role})
        key = response["AccessKey"]
        save(role + "-credentials.json", {"SecretId": key["AccessKeyId"], "SecretKey": key["SecretAccessKey"]})
        save(state_file, state)
    state.update(phase="ready", prefix="qintopia-image/releases/")
    save(state_file, state)
    return {"identity": name, "uin": state["uin"], "policy_id": state["policy_id"], "credentials_saved_privately": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["plan", "apply"])
    args = parser.parse_args()
    if args.mode == "plan":
        print(json.dumps({"bucket": "qintopia-image-1305166808", "region": "ap-shanghai", "prefix": "qintopia-image/releases/", "roles": ["upload", "reader", "retention"], "runtime_prefix_unchanged": "image-playground/"}))
        return
    sys.path.insert(0, str(ROOT / "ops/image-storage"))
    import cloud
    results = [provision(role, cloud) for role in ("upload", "reader", "retention")]
    print(json.dumps({"identities": results}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error_type": type(error).__name__, "code": getattr(error, "code", None), "message": str(error) if isinstance(error, RuntimeError) else "Provisioning stopped; inspect saved intent before retrying."}))
        raise SystemExit(1)
