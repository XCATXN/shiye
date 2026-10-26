"""Compare a single-conversation reference export with captured response pages.

Read-only with respect to all input files. No network access or credentials.
Never equates an exhausted selected-path cursor with complete branch coverage.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON object key: {key}")
        result[key] = value
    return result


def read_document(path):
    raw = path.read_bytes()
    value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=reject_duplicate_keys)
    if isinstance(value, list):
        if len(value) != 1:
            raise ValueError(f"{path.name}: select exactly one conversation first")
        value = value[0]
    if not isinstance(value, dict):
        raise ValueError(f"{path.name}: expected a conversation object")
    return value, {"path": str(path.resolve()), "bytes": len(raw),
                   "sha256": hashlib.sha256(raw).hexdigest()}


def message_items(document):
    if isinstance(document.get("mapping"), dict):
        return [n["message"] for n in document["mapping"].values()
                if isinstance(n, dict) and n.get("message") is not None]
    if isinstance(document.get("messages"), list):
        return document["messages"]
    raise ValueError("Unsupported structure: neither mapping nor messages is present")


def index_messages(items):
    indexed = {}
    repeats = []
    for message in items:
        if not isinstance(message, dict) or not isinstance(message.get("id"), str):
            raise ValueError("Every message must have a string id")
        key = message["id"]
        if key in indexed:
            repeats.append(key)
        indexed[key] = message
    return indexed, repeats


def payload(message):
    author = message.get("author") or {}
    return {"content": message.get("content"), "role": author.get("role"),
            "name": author.get("name"), "create_time": message.get("create_time")}


def digest(value):
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def local_time(value):
    return datetime.fromtimestamp(value, timezone(timedelta(hours=8))).isoformat()


def statistics(messages):
    values = list(messages)
    times = [m["create_time"] for m in values
             if isinstance(m.get("create_time"), (int, float))]
    kinds = Counter((m.get("content") or {}).get("content_type") for m in values)
    return {"records": len(values), "ordinary_text_records": kinds.get("text", 0),
            "roles": dict(Counter((m.get("author") or {}).get("role") for m in values)),
            "content_types": dict(kinds),
            "first_message_time": local_time(min(times)) if times else None,
            "last_message_time": local_time(max(times)) if times else None}


def audit(reference_path, page_paths, request_urls=None):
    reference, reference_file = read_document(reference_path)
    conversation_id = reference.get("conversation_id") or reference.get("id")
    if not conversation_id:
        raise ValueError("Reference has no conversation id")
    expected, duplicate_reference_ids = index_messages(message_items(reference))
    if duplicate_reference_ids:
        raise ValueError("Reference contains duplicate message ids")
    if not expected:
        raise ValueError("Reference contains no messages")
    request_urls = request_urls or {}

    captured = {}
    versions = {}
    evidence = []
    conflicts = set()
    duplicate_page_ids = []
    for page_path in page_paths:
        page, file_info = read_document(page_path)
        page_id = page.get("conversation_id") or page.get("id")
        if page_id is not None and page_id != conversation_id:
            raise ValueError(f"{page_path.name}: different conversation id")
        request_url = request_urls.get(str(page_path.resolve()))
        identity_verified = page_id == conversation_id
        identity_source = "response" if identity_verified else "unverified"
        if request_url:
            from pagination import parse_observed_request
            from urllib.parse import urlsplit
            parsed = urlsplit(request_url)
            if (parsed.scheme == "https" and parsed.netloc == "chatgpt.com" and not parsed.fragment and
                    parsed.path in [f"/backend-api/conversation/{conversation_id}", f"/backend-api/conversations/{conversation_id}"]):
                request = {"conversation_id": conversation_id}
            else:
                request = parse_observed_request(request_url)
            if request["conversation_id"] != conversation_id:
                raise ValueError(f"{page_path.name}: request belongs to a different conversation")
            identity_verified = True
            identity_source = "response_and_request" if page_id else "supplied_request"
        indexed, duplicate_ids = index_messages(message_items(page))
        duplicate_page_ids.extend(duplicate_ids)
        for key, value in indexed.items():
            fingerprint = digest(payload(value))
            versions.setdefault(key, set()).add(fingerprint)
            if len(versions[key]) > 1:
                conflicts.add(key)
            captured.setdefault(key, value)
        info = page.get("page_info")
        evidence.append({**file_info, "conversation_id_verified": identity_verified,
                         "identity_source": identity_source, "request_url": request_url,
                         "page_info": info, "records": len(indexed),
                         "current_node": page.get("current_node"),
                         "metadata_parent_records": sum(
                             "parent_id" in (m.get("metadata") or {}) for m in indexed.values()),
                         "messages_with_versions": [k for k, m in indexed.items()
                             if (m.get("metadata") or {}).get("has_versions") is True]})

    common = set(expected) & set(captured)
    missing = sorted(set(expected) - set(captured))
    extra = sorted(set(captured) - set(expected))
    changed_content = sorted(k for k in common
                             if expected[k].get("content") != captured[k].get("content"))
    changed_payload = sorted(k for k in common if payload(expected[k]) != payload(captured[k]))
    full_record_changes = sorted(k for k in common if expected[k] != captured[k])
    reference_latest = max((m.get("create_time") or 0) for m in expected.values())
    extra_after_reference = [k for k in extra
                             if (captured[k].get("create_time") or 0) > reference_latest]
    pages_with_more_history = [i for i, e in enumerate(evidence)
        if isinstance(e["page_info"], dict) and e["page_info"].get("has_previous_page") is True]
    observed_start = any(isinstance(e["page_info"], dict)
        and e["page_info"].get("has_previous_page") is False for e in evidence)
    reference_covered = not missing and not changed_payload and not conflicts and not duplicate_page_ids
    identity_verified = all(e["conversation_id_verified"] for e in evidence)
    return {
        "schema": "chat-export-audit/v1", "conversation_id": conversation_id,
        "title": reference.get("title"), "reference_file": reference_file,
        "reference": statistics(expected.values()), "captured": statistics(captured.values()),
        "overlap": {"records": len(common), "identical_content_records": len(common)-len(changed_content),
                    "identical_payload_records": len(common)-len(changed_payload),
                    "different_full_record_count": len(full_record_changes)},
        "missing_reference": {**statistics(expected[k] for k in missing), "message_ids": missing},
        "additional_captured": {**statistics(captured[k] for k in extra), "message_ids": extra,
                                "after_reference_last_message": len(extra_after_reference)},
        "changed_content_ids": changed_content, "changed_payload_ids": changed_payload,
        "same_id_payload_conflicts": sorted(conflicts),
        "duplicate_ids_within_single_pages": duplicate_page_ids,
        "pages": evidence,
        "checks": {
            "all_pages_conversation_id_verified": identity_verified,
            "reference_message_payloads_fully_covered": reference_covered and identity_verified,
            "earliest_page_boundary_observed": observed_start,
            "page_indices_reporting_more_history": pages_with_more_history,
            "page_chain_continuity": "not_verified_without_request_cursor_evidence",
            "complete_branch_structure": "not_verified",
            "complete_current_server_conversation": "not_verified",
            "capture_ready_for_complete_backup_claim": False,
        },
        "scope": [
            "Content is compared structurally without trimming or Unicode normalization.",
            "Metadata differences are distinct from content differences.",
            "metadata.parent_id is not assumed equivalent to a mapping node's parent.",
            "An earliest-page flag is not proof of a continuous page chain or complete branches.",
            "Reference coverage establishes coverage only of this supplied reference snapshot.",
            "No network requests are made and no input files are changed.",
        ],
    }


def markdown_report(report):
    a, b = report["reference"], report["captured"]
    overlap = report["overlap"]
    missing = report["missing_reference"]
    extra = report["additional_captured"]
    capture_checks = report.get("capture_checks") or {}
    if capture_checks.get("mode") == "full_mapping":
        progress = [
            "本次读取的是 mapping 完整结构响应，不适用分页到头标记。",
            f"两次结构和正文复核一致：{capture_checks.get('full_mapping_recheck_matches', False)}。",
            "结构内部校验与官方参考覆盖率分别报告；仍不宣称服务器全部历史已验证。",
        ]
    elif capture_checks:
        progress = [
            f"已观察到最早页边界：{capture_checks.get('earliest_selected_path_boundary_observed', False)}。",
            f"已记录请求的游标衔接通过：{capture_checks.get('recorded_request_cursor_links_valid', False)}。",
            "全部历史分支及服务器当前总量仍未验证。",
        ]
    else:
        progress = [
            f"已观察到最早页边界：{report['checks']['earliest_page_boundary_observed']}。",
            "分页连续性、全部分支关系及服务器当前总量仍未验证。",
        ]
    return "\n".join([
        "# 单聊天导出核对", "", f"聊天：{report['title']}", "",
        "本核对程序不发起网络请求；结论来自所提供文件，不代表服务器全量已经验证。", "",
        "| 项目 | 官方参考文件 | 网页采集文件（合并去重后） |",
        "| --- | ---: | ---: |",
        f"| 消息记录 | {a['records']} | {b['records']} |",
        f"| 普通文本记录 | {a['ordinary_text_records']} | {b['ordinary_text_records']} |",
        f"| 最早消息 | {a['first_message_time']} | {b['first_message_time']} |",
        f"| 最晚消息 | {a['last_message_time']} | {b['last_message_time']} |", "",
        f"- 重叠消息：{overlap['records']} 条；正文一致：{overlap['identical_content_records']} 条。",
        f"- 重叠消息中正文不同：{len(report['changed_content_ids'])} 条。",
        f"- 参考文件中尚未采集的消息：{missing['records']} 条，其中普通文本 {missing['ordinary_text_records']} 条。",
        f"- 采集文件独有消息：{extra['records']} 条，其中 {extra['after_reference_last_message']} 条晚于参考文件的最晚消息。",
        f"- 同 ID、不同内容或作者时间的采集冲突：{len(report['same_id_payload_conflicts'])} 条。", "",
        "## 完整性结论", "",
        "当前文件不能作为完整聊天备份。" if not report['checks']['reference_message_payloads_fully_covered']
            else "所提供参考文件的消息内容已覆盖；这不等于完整当前聊天或完整分支已经验证。", "",
        *progress, "",
        "网页元数据里的 parent_id 不能直接当作官方 mapping 节点的 parent。",
        "完整判断还需要真实请求游标、连续分页证据，以及分支采集和对照。", "",
        "JSON 报告保留源文件 SHA-256、缺失消息 ID、分页标记和逐项验收状态。", "",
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("pages", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    markdown_path = args.output.with_suffix(".md")
    if args.output.exists() or markdown_path.exists():
        parser.error("Output already exists; choose a new filename to preserve earlier evidence")
    report = audit(args.reference, args.pages)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    with markdown_path.open("x", encoding="utf-8") as handle:
        handle.write(markdown_report(report))
    print(json.dumps({"output": str(args.output.resolve()),
                      "markdown": str(markdown_path.resolve()),
                      "reference_records": report["reference"]["records"],
                      "captured_records": report["captured"]["records"],
                      "missing_records": report["missing_reference"]["records"],
                      "overlap": report["overlap"], "checks": report["checks"]}, ensure_ascii=True))


if __name__ == "__main__":
    main()
