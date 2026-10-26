from copy import deepcopy
import hashlib
import json
import unittest

from full_capture import inspect_full_mapping, compare_reference_graph
from verify_capture import validate_bundle

CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
A, B, C, D, E = [f"00000000-0000-4000-8000-{i:012d}" for i in range(1, 6)]


def tree():
    return {"conversation_id": CID, "current_node": C, "mapping": {
        A: {"id": A, "parent": None, "message": None},
        B: {"id": B, "parent": A, "message": {"id": B, "author": {"role": "user"}, "content": {"content_type": "text", "parts": ["问题"]}}},
        C: {"id": C, "parent": B, "message": {"id": C, "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["当前回答"]}}},
        D: {"id": D, "parent": B, "message": {"id": D, "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["旧回答"]}}}}}


def record(sequence, kind, value):
    raw = json.dumps(value, ensure_ascii=False)
    return {"sequence": sequence, "kind": kind, "accepted": True,
            "request": {"method": "GET", "url": f"https://chatgpt.com/backend-api/conversation/{CID}?include_full_conversation=true"},
            "response": {"status": 200, "body_text": raw, "body_sha256": hashlib.sha256(raw.encode()).hexdigest()},
            "validation": {"recheck_of_sequence": 0 if kind == "full_recheck" else None}}


class FullCaptureTests(unittest.TestCase):
    def setUp(self):
        self.bundle = {"schema": "chat-export-capture/v2", "conversation_id": CID,
                       "capture": {"state": "full_complete"},
                       "pages": [record(0, "full", tree()), record(1, "full_recheck", tree())]}

    def test_valid_rechecked_tree_keeps_server_completeness_unverified(self):
        _, accepted, checks = validate_bundle(self.bundle)
        self.assertEqual(len(accepted), 1)
        self.assertTrue(checks["full_mapping_read_checks_pass"])
        self.assertEqual(checks["mapping_structure"]["branch_points"], 1)
        self.assertFalse(checks["all_history_branches_verified"])

    def test_changed_old_branch_is_detected(self):
        changed = tree()
        changed["mapping"][D]["message"]["content"]["parts"] = ["不同"]
        self.bundle["pages"][1] = record(1, "full_recheck", changed)
        with self.assertRaisesRegex(ValueError, "changed"):
            validate_bundle(self.bundle)

    def test_finished_without_second_read_is_rejected(self):
        self.bundle["pages"].pop()
        with self.assertRaisesRegex(ValueError, "no successful recheck"):
            validate_bundle(self.bundle)

    def test_missing_parent_is_rejected(self):
        bad = tree();bad["mapping"][B]["parent"] = E
        with self.assertRaisesRegex(ValueError, "missing parent"):
            inspect_full_mapping(bad, CID)

    def test_empty_text_is_reported(self):
        value = tree();value["mapping"][B]["message"]["content"]["parts"] = [""]
        self.assertEqual(inspect_full_mapping(value, CID)["empty_text_ids"], [B])

    def test_reference_projection_is_distinct_from_raw_parent_equality(self):
        reference = tree();full = deepcopy(reference)
        full["mapping"][E] = {"id": E, "parent": B, "message": None}
        full["mapping"][C]["parent"] = E
        comparison = compare_reference_graph(reference, full)
        self.assertEqual(comparison["raw_parent_difference_ids"], [C])
        self.assertEqual(comparison["parent_difference_after_skipping_additional_nodes_ids"], [])
        self.assertEqual(full["mapping"][C]["parent"], E)

    def test_full_flag_cannot_be_omitted(self):
        self.bundle["pages"][0]["request"]["url"] = f"https://chatgpt.com/backend-api/conversation/{CID}"
        with self.assertRaisesRegex(ValueError, "source-verified"):
            validate_bundle(self.bundle)

    def observed_bundle(self):
        bundle = deepcopy(self.bundle)
        bundle["schema"] = "chat-export-observed-mapping/v1"
        bundle["capture"]["state"] = "mapping_complete"
        for item in bundle["pages"]:
            item["kind"] = item["kind"].replace("full", "mapping")
            item["request"]["url"] = f"https://chatgpt.com/backend-api/conversation/{CID}"
        return bundle

    def test_observed_mapping_is_a_separate_scope_with_a_fresh_recheck(self):
        _, _, checks = validate_bundle(self.observed_bundle())
        self.assertEqual(checks["mode"], "observed_mapping")
        self.assertTrue(checks["observed_mapping_read_checks_pass"])
        self.assertFalse(checks["forced_full_endpoint_requested"])
        self.assertFalse(checks["all_history_branches_verified"])

    def test_observed_mapping_does_not_accept_forced_or_paginated_urls(self):
        for suffix in ["?include_full_conversation=true&other=1", "?before=" + A, "/messages"]:
            bundle = self.observed_bundle()
            bundle["pages"][0]["request"]["url"] += suffix
            with self.assertRaisesRegex(ValueError, "ordinary conversation head"):
                validate_bundle(bundle)

    def test_observed_mapping_requires_matching_second_read_to_finish(self):
        bundle = self.observed_bundle()
        bundle["pages"].pop()
        with self.assertRaisesRegex(ValueError, "no successful recheck"):
            validate_bundle(bundle)


if __name__ == "__main__":
    unittest.main()
