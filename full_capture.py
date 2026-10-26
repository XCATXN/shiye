"""Inspect full mapping snapshots without assuming they cover server history."""
import hashlib
import json
from urllib.parse import parse_qsl, urlsplit

from audit_exports import payload, reject_duplicate_keys
from pagination import identifier


def inspect_full_mapping(value, cid):
    if not isinstance(value, dict) or (value.get("conversation_id") or value.get("id")) != cid:
        raise ValueError("Full mapping conversation id does not match")
    if value.get("id") is not None and value["id"] != cid:
        raise ValueError("Full response contains conflicting conversation ids")
    mapping = value.get("mapping")
    if not isinstance(mapping, dict) or not mapping:
        raise ValueError("Response does not contain a nonempty mapping")
    info = value.get("page_info") or {}
    if info.get("has_previous_page") or info.get("has_next_page") or value.get("is_partial") is True or value.get("truncated") is True:
        raise ValueError("Response is explicitly partial")
    children = {key: [] for key in mapping}
    roots, message_ids, messages = [], set(), []
    for key, node in mapping.items():
        if not isinstance(node, dict) or node.get("id") != key or "parent" not in node:
            raise ValueError("Invalid mapping node id or missing parent")
        parent = node["parent"]
        if parent is None:
            roots.append(key)
        elif parent not in mapping:
            raise ValueError("Mapping references a missing parent")
        else:
            children[parent].append(key)
        message = node.get("message")
        if message is not None:
            mid = identifier(message.get("id"))
            if mid in message_ids:
                raise ValueError("Mapping repeats a message id")
            message_ids.add(mid)
            messages.append(message)
    if len(roots) != 1:
        raise ValueError("Mapping does not have exactly one root")
    for key, node in mapping.items():
        if "children" in node:
            actual = node["children"]
            if not isinstance(actual, list) or len(actual) != len(set(actual)) or set(actual) != set(children[key]):
                raise ValueError("Mapping child links disagree with parent links")
    stack, visited = roots[:], set()
    while stack:
        key = stack.pop()
        if key in visited:
            raise ValueError("Mapping has a cycle")
        visited.add(key)
        stack.extend(children[key])
    if len(visited) != len(mapping):
        raise ValueError("Mapping has unreachable nodes")
    if value.get("current_node") not in mapping:
        raise ValueError("Current node is absent from mapping")
    current_path = set()
    node = value["current_node"]
    while node is not None:
        current_path.add(node)
        node = mapping[node]["parent"]
    empty = [m["id"] for m in messages if m.get("author", {}).get("role") in ["user", "assistant"]
             and m.get("content", {}).get("content_type") == "text"
             and isinstance(m["content"].get("parts"), list)
             and all(isinstance(p, str) and not p.strip() for p in m["content"]["parts"])]
    return {"nodes": len(mapping), "messages": len(messages),
            "branch_points": sum(len(v) > 1 for v in children.values()),
            "off_current_path_nodes": len(mapping) - len(current_path),
            "empty_text_ids": empty, "structure_valid": True,
            "reference_coverage_verified": False, "complete_server_history_verified": False}


def mapping_payload(value):
    return {"current_node": value["current_node"], "mapping": {
        key: {"id": node["id"], "parent": node["parent"], "children": node.get("children"),
              "message": {"id": node["message"]["id"], **payload(node["message"])} if node.get("message") else None}
        for key, node in value["mapping"].items()}}


def validate_full_bundle(bundle):
    observed = bundle.get("schema") == "chat-export-observed-mapping/v1"
    cid = identifier(bundle.get("conversation_id"))
    records = bundle.get("pages")
    if not isinstance(records, list) or not records:
        raise ValueError("No full-read response records")
    if not all(type(r.get("sequence")) is int and 0 <= r["sequence"] < 20000 for r in records):
        raise ValueError("Invalid response sequence")
    if len({r["sequence"] for r in records}) != len(records):
        raise ValueError("Duplicate response sequence")
    records = sorted(records, key=lambda r: r["sequence"])
    first = None
    first_record = None
    rechecked = False
    structure = None
    for record in records:
        req, res = record.get("request") or {}, record.get("response") or {}
        url = urlsplit(req.get("url", ""))
        prefixes = [f"/backend-api/conversation/{cid}", f"/backend-api/conversations/{cid}"]
        if url.scheme != "https" or url.netloc != "chatgpt.com" or url.fragment or not any(url.path == p or url.path.startswith(p + "/") for p in prefixes):
            raise ValueError("Full-read response URL is outside the conversation")
        if req.get("method") != "GET" or "headers" in req:
            raise ValueError("Only GET request metadata without headers is accepted")
        raw = res.get("body_text")
        if not isinstance(raw, str) or hashlib.sha256(raw.encode("utf-8")).hexdigest() != res.get("body_sha256"):
            raise ValueError("Full-read response hash mismatch")
        if record.get("accepted") is not True:
            continue
        if res.get("status") != 200:
            raise ValueError("Accepted full-read response is not HTTP 200")
        value = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
        kind = record.get("kind")
        if observed:
            if kind not in ["mapping", "mapping_recheck"]:
                raise ValueError("Unknown observed mapping record kind")
            kind = {"mapping": "full", "mapping_recheck": "full_recheck"}[kind]
        if kind == "full_bootstrap":
            if (value.get("conversation_id") or value.get("id")) != cid:
                raise ValueError("Bootstrap conversation id mismatch")
            continue
        if kind not in ["full", "full_recheck"]:
            raise ValueError("Unknown full-read record kind")
        if observed:
            if url.path not in prefixes or any(k in ["before", "after"] or (k == "include_full_conversation" and v != "false")
                                              for k, v in parse_qsl(url.query, keep_blank_values=True)):
                raise ValueError("Observed mapping must come from an ordinary conversation head")
        elif url.path != f"/backend-api/conversation/{cid}" or parse_qsl(url.query) != [("include_full_conversation", "true")]:
            raise ValueError("Full snapshot lacks the source-verified full-conversation request")
        inspected = inspect_full_mapping(value, cid)
        if kind == "full":
            if first is not None:
                raise ValueError("Multiple initial full snapshots are ambiguous")
            first, first_record, structure = value, record, inspected
        else:
            if first is None or (record.get("validation") or {}).get("recheck_of_sequence") != first_record["sequence"]:
                raise ValueError("Full recheck has no matching initial snapshot")
            if mapping_payload(first) != mapping_payload(value):
                raise ValueError("Full snapshot contents or structure changed")
            rechecked = True
    if first is None:
        raise ValueError("No accepted full mapping; inspect rejected raw responses")
    if (bundle.get("capture") or {}).get("state") in ["full_complete", "mapping_complete"] and not rechecked:
        raise ValueError("Completed full read has no successful recheck")
    checks = {"raw_body_hashes_valid": True, "mode": "full_mapping",
              "mapping_structure": structure, "full_mapping_recheck_matches": rechecked,
              "full_mapping_read_checks_pass": rechecked,
              "all_history_branches_verified": False,
              "complete_current_server_conversation": "not_verified"}
    if observed:
        checks["mode"] = "observed_mapping"
        checks["mapping_recheck_matches"] = checks.pop("full_mapping_recheck_matches")
        checks["observed_mapping_read_checks_pass"] = checks.pop("full_mapping_read_checks_pass")
        checks["forced_full_endpoint_requested"] = False
    return records, [(first_record, first)], checks


def compare_reference_graph(reference, captured):
    expected, actual = reference["mapping"], captured["mapping"]
    shared = set(expected) & set(actual)
    direct, projected = [], []
    for key in sorted(shared):
        parent = actual[key]["parent"]
        if parent != expected[key].get("parent"):
            direct.append(key)
        seen = set()
        while parent is not None and parent not in expected and parent in actual and parent not in seen:
            seen.add(parent)
            parent = actual[parent]["parent"]
        if parent != expected[key].get("parent"):
            projected.append(key)
    return {"reference_nodes": len(expected), "captured_nodes": len(actual),
            "missing_reference_node_ids": sorted(set(expected) - set(actual)),
            "raw_parent_difference_ids": direct,
            "parent_difference_after_skipping_additional_nodes_ids": projected,
            "note": "Projection is reported separately; original nodes and links are never changed."}
