"""Unpack and verify a local collector bundle; compare with a reference export."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from audit_exports import audit, markdown_report, payload, reject_duplicate_keys
from pagination import identifier, inspect_page, validate_previous_page


def head_payload(page):
    return {"current_node": page.get("current_node"), "end_cursor": page["page_info"]["end_cursor"],
            "messages": [{"id": m["id"], **payload(m)} for m in page["messages"]]}


def validate_bundle(bundle):
    if isinstance(bundle, dict) and bundle.get("schema") in ["chat-export-capture/v2", "chat-export-observed-mapping/v1"]:
        from full_capture import validate_full_bundle
        return validate_full_bundle(bundle)
    if not isinstance(bundle, dict) or bundle.get("schema") != "chat-export-capture/v1":
        raise ValueError("Unsupported capture format")
    cid = identifier(bundle.get("conversation_id"))
    records = bundle.get("pages")
    if not isinstance(records, list) or not records:
        raise ValueError("Capture contains no response records")
    if not all(type(r.get("sequence")) is int and 0 <= r["sequence"] < 20000 for r in records):
        raise ValueError("Invalid response sequence")
    if len({r["sequence"] for r in records}) != len(records):
        raise ValueError("Duplicate response sequence")
    records = sorted(records, key=lambda r: r["sequence"])
    accepted = []
    rechecks = []
    seen_starts = []
    head = None
    for record in records:
        request = record.get("request") or {}
        response = record.get("response") or {}
        url = urlsplit(request.get("url", ""))
        prefix = (f"/backend-api/conversation/{cid}", f"/backend-api/conversations/{cid}")
        if url.scheme != "https" or url.netloc != "chatgpt.com" or not any(url.path == p or url.path.startswith(p + "/") for p in prefix):
            raise ValueError("A response URL is outside the selected conversation")
        if request.get("method") != "GET" or "headers" in request:
            raise ValueError("Only GET request metadata without headers is accepted")
        raw = response.get("body_text")
        if not isinstance(raw, str) or hashlib.sha256(raw.encode("utf-8")).hexdigest() != response.get("body_sha256"):
            raise ValueError(f"Response body hash mismatch at sequence {record['sequence']}")
        if record.get("accepted") is not True:
            continue
        if response.get("status") != 200:
            raise ValueError("An accepted response does not have HTTP status 200")
        page = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
        info = inspect_page(page, cid)
        kind = record.get("kind")
        if kind in ["head", "head_recheck"]:
            if url.fragment or url.path not in prefix or any(k in ["before", "after"] or (k == "include_full_conversation" and v != "false")
                                                          for k, v in parse_qsl(url.query, keep_blank_values=True)):
                raise ValueError("Head response is not an ordinary conversation head request")
            if any(page.get(k) is not None and page[k] != cid for k in ["conversation_id", "id"]):
                raise ValueError("Head response contains a conflicting conversation id")
        if kind == "head":
            if head is not None:
                raise ValueError("Invalid or repeated head response")
            if page["page_info"].get("has_next_page") is not False or (page.get("current_node") is not None and page["current_node"] != info["end"]):
                raise ValueError("Head is not the latest selected-path page")
            head = page
        elif kind == "previous":
            if not accepted:
                raise ValueError("A previous-page response appears before the head")
            last_record, last_page = accepted[-1]
            if (record.get("validation") or {}).get("parent_page_sequence") != last_record["sequence"]:
                raise ValueError("Recorded request/page linkage is discontinuous")
            validate_previous_page(last_page, page, request["url"], seen_starts)
        elif kind == "head_recheck":
            if head is None or head_payload(page) != head_payload(head):
                raise ValueError("Head content changed during capture")
            rechecks.append(record["sequence"])
            continue
        else:
            raise ValueError("Unknown accepted response kind")
        accepted.append((record, page))
        seen_starts.append(info["start"])
    if not accepted:
        raise ValueError("No accepted head/page response was captured")
    last_record, last_page = accepted[-1]
    boundary = last_page["page_info"]["has_previous_page"] is False
    final_recheck = any(sequence > last_record["sequence"] for sequence in rechecks)
    claimed_finished = (bundle.get("capture") or {}).get("state") == "route_complete"
    if claimed_finished and not (boundary and final_recheck):
        raise ValueError("Finished status lacks an earliest boundary and final head recheck")
    checks = {"raw_body_hashes_valid": True, "recorded_request_cursor_links_valid": True,
              "earliest_selected_path_boundary_observed": boundary,
              "final_head_recheck_matches": final_recheck,
              "selected_path_capture_checks_pass": boundary and final_recheck,
              "all_history_branches_verified": False,
              "complete_current_server_conversation": "not_verified"}
    return records, accepted, checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.output_dir.exists():
        parser.error("Choose a new output directory; existing evidence is never overwritten")
    raw = args.capture.read_bytes()
    bundle = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=reject_duplicate_keys)
    records, accepted, checks = validate_bundle(bundle)
    args.output_dir.mkdir(parents=True, exist_ok=False)
    page_dir = args.output_dir / "raw_pages"
    page_dir.mkdir()
    selected = {r["sequence"] for r, _ in accepted}
    page_paths, request_urls = [], {}
    for record in records:
        path = page_dir / f"response_{record['sequence']:05d}.json"
        path.write_text(record["response"]["body_text"], encoding="utf-8", newline="")
        if record["sequence"] in selected:
            page_paths.append(path)
            request_urls[str(path.resolve())] = record["request"]["url"]
    report = audit(args.reference, page_paths, request_urls=request_urls)
    report["capture_file"] = {"path": str(args.capture.resolve()), "sha256": hashlib.sha256(raw).hexdigest()}
    report["capture_checks"] = checks
    if checks.get("mode") in ["full_mapping", "observed_mapping"]:
        from full_capture import compare_reference_graph
        reference = json.loads(args.reference.read_text(encoding="utf-8-sig"), object_pairs_hook=reject_duplicate_keys)
        if isinstance(reference, list) and len(reference) == 1:
            reference = reference[0]
        report["reference_graph_comparison"] = compare_reference_graph(reference, accepted[0][1])
        report["checks"]["page_chain_continuity"] = "not_applicable_full_mapping"
        report["checks"]["complete_branch_structure"] = "returned_mapping_structurally_validated_reference_comparison_separate"
    else:
        report["checks"]["page_chain_continuity"] = "recorded_request_cursor_links_verified"
    report["checks"]["capture_ready_for_complete_backup_claim"] = False
    output = args.output_dir / "核对结果.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output_dir / "核对结果.md").write_text(markdown_report(report) + "\n## 分页采集证据\n\n" +
        "```json\n" + json.dumps(checks, ensure_ascii=False, indent=2) + "\n```\n", encoding="utf-8")
    print(json.dumps({"report": str(output.resolve()), "captured_records": report["captured"]["records"],
                      "missing_reference_records": report["missing_reference"]["records"], "capture_checks": checks}, ensure_ascii=True))


if __name__ == "__main__":
    main()
