from __future__ import annotations

import hashlib
import hmac
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple


class R2Error(RuntimeError):
    """Raised when an R2 request fails."""


@dataclass
class R2Profile:
    account_id: str
    access_key_id: str
    bucket: str
    secret_access_key: str
    endpoint: str
    region: str = "auto"
    memory_prefix: str = "projects/"


def validate_r2_credentials(profile: R2Profile, timeout: int = 15) -> Dict[str, str]:
    response = signed_r2_request(
        profile,
        method="GET",
        path="/" + urllib.parse.quote(profile.bucket, safe="-_.~/"),
        query={"list-type": "2", "max-keys": "1"},
        timeout=timeout,
    )
    return {
        "status": str(response["status"]),
        "request_url": response["url"],
        "bucket": profile.bucket,
    }


def put_r2_object(profile: R2Profile, key: str, payload: bytes, timeout: int = 30) -> Dict[str, str]:
    return signed_r2_request(
        profile,
        method="PUT",
        path=_object_path(profile.bucket, key),
        payload=payload,
        timeout=timeout,
    )


def get_r2_object(profile: R2Profile, key: str, timeout: int = 30) -> bytes:
    response = signed_r2_request(
        profile,
        method="GET",
        path=_object_path(profile.bucket, key),
        timeout=timeout,
    )
    return response["body_bytes"]


def delete_r2_object(profile: R2Profile, key: str, timeout: int = 30) -> Dict[str, str]:
    return signed_r2_request(
        profile,
        method="DELETE",
        path=_object_path(profile.bucket, key),
        timeout=timeout,
    )


def list_r2_objects(profile: R2Profile, prefix: str = "", timeout: int = 30) -> list[dict[str, str]]:
    continuation_token = None
    results: list[dict[str, str]] = []
    while True:
        query = {"list-type": "2", "prefix": prefix}
        if continuation_token:
            query["continuation-token"] = continuation_token
        response = signed_r2_request(
            profile,
            method="GET",
            path="/" + urllib.parse.quote(profile.bucket, safe="-_.~/"),
            query=query,
            timeout=timeout,
        )
        payload = _parse_list_objects(response["body"])
        results.extend(payload["objects"])
        continuation_token = payload["next_token"]
        if not continuation_token:
            return results


def signed_r2_request(
    profile: R2Profile,
    method: str,
    path: str,
    query: Optional[Dict[str, str]] = None,
    payload: bytes = b"",
    extra_headers: Optional[Dict[str, str]] = None,
    timeout: int = 15,
) -> Dict[str, object]:
    parsed = urllib.parse.urlparse(profile.endpoint)
    if not parsed.scheme or not parsed.netloc:
        raise R2Error(f"Invalid endpoint: {profile.endpoint}")

    canonical_path = _canonical_uri(path)
    canonical_query = _canonical_query_string(query or {})
    payload_hash = hashlib.sha256(payload).hexdigest()
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")

    headers = {
        "host": parsed.netloc,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if extra_headers:
        headers.update({key.lower(): value for key, value in extra_headers.items()})

    canonical_headers = "".join(f"{key}:{headers[key]}\n" for key in sorted(headers))
    signed_headers = ";".join(sorted(headers))
    canonical_request = "\n".join(
        [
            method.upper(),
            canonical_path,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )

    credential_scope = f"{datestamp}/{profile.region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signing_key = _signing_key(profile.secret_access_key, datestamp, profile.region, "s3")
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={profile.access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    request_headers = {
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Authorization": authorization,
    }
    url = urllib.parse.urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            canonical_path,
            "",
            canonical_query,
            "",
        )
    )
    request = urllib.request.Request(url=url, data=payload or None, method=method.upper(), headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body_bytes = response.read()
            body = body_bytes.decode("utf-8", errors="replace")
            return {"status": str(response.status), "body": body, "body_bytes": body_bytes, "url": url}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise R2Error(_format_r2_error(error.code, body)) from error
    except urllib.error.URLError as error:
        raise R2Error(f"Failed to reach R2 endpoint: {error.reason}") from error


def _object_path(bucket: str, key: str) -> str:
    quoted_bucket = urllib.parse.quote(bucket, safe="-_.~/")
    quoted_key = urllib.parse.quote(key.lstrip("/"), safe="/-_.~")
    return f"/{quoted_bucket}/{quoted_key}"


def _canonical_uri(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return urllib.parse.quote(path, safe="/-_.~")


def _canonical_query_string(query: Dict[str, str]) -> str:
    items = []
    for key, value in sorted(query.items()):
        items.append(
            (
                urllib.parse.quote(str(key), safe="-_.~"),
                urllib.parse.quote(str(value), safe="-_.~"),
            )
        )
    return "&".join(f"{key}={value}" for key, value in items)


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret_access_key: str, datestamp: str, region: str, service: str) -> bytes:
    k_date = _sign(("AWS4" + secret_access_key).encode("utf-8"), datestamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    return _sign(k_service, "aws4_request")


def _format_r2_error(status: int, body: str) -> str:
    code, message = _extract_xml_error(body)
    if code or message:
        detail = " / ".join(part for part in (code, message) if part)
        return f"R2 request failed with HTTP {status}: {detail}"
    return f"R2 request failed with HTTP {status}"


def _extract_xml_error(body: str) -> Tuple[Optional[str], Optional[str]]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None, None
    code = root.findtext(".//Code")
    message = root.findtext(".//Message")
    return code, message


def _parse_list_objects(body: str) -> dict[str, object]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return {"objects": [], "next_token": None}
    namespace = ""
    if root.tag.startswith("{"):
        namespace = root.tag.split("}", 1)[0] + "}"
    objects = []
    for content in root.findall(f".//{namespace}Contents"):
        objects.append(
            {
                "key": content.findtext(f"{namespace}Key", default=""),
                "etag": content.findtext(f"{namespace}ETag", default=""),
                "last_modified": content.findtext(f"{namespace}LastModified", default=""),
                "size": content.findtext(f"{namespace}Size", default="0"),
            }
        )
    next_token = root.findtext(f".//{namespace}NextContinuationToken")
    return {"objects": objects, "next_token": next_token}
