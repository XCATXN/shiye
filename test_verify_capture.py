import hashlib
import json
import unittest
from copy import deepcopy

from verify_capture import validate_bundle

CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
A = "00000000-0000-4000-8000-000000000001"
B = "00000000-0000-4000-8000-000000000002"
C = "00000000-0000-4000-8000-000000000003"
D = "00000000-0000-4000-8000-000000000004"


def page(ids, previous, head=False):
    value = {"messages": [{"id": i, "author": {"role": "user"},
                            "content": {"content_type": "text", "parts": [i]},
                            "create_time": 1.0} for i in ids],
             "page_info": {"start_cursor": ids[0], "end_cursor": ids[-1],
                           "has_previous_page": previous, "has_next_page": not head}}
    if head:
        value.update(conversation_id=CID, current_node=ids[-1])
    return value


def record(sequence, kind, value):
    raw = json.dumps(value, ensure_ascii=False)
    url = f"https://chatgpt.com/backend-api/conversation/{CID}"
    if kind == "previous":
        url = f"https://chatgpt.com/backend-api/conversations/{CID}/messages?before={C}&include_has_versions=true&num_turns=10"
    return {"sequence": sequence, "kind": kind, "accepted": True,
            "request": {"url": url, "method": "GET"},
            "response": {"status": 200, "body_text": raw,
                         "body_sha256": hashlib.sha256(raw.encode()).hexdigest()},
            "validation": {"parent_page_sequence": 0 if kind == "previous" else None}}


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.head = page([C, D], True, head=True)
        self.bundle = {"schema": "chat-export-capture/v1", "conversation_id": CID,
                       "capture": {"state": "route_complete"},
                       "pages": [record(0, "head", self.head),
                                 record(1, "previous", page([A, B], False)),
                                 record(2, "head_recheck", self.head)]}

    def test_chain_and_recheck_can_pass_without_claiming_complete_branches(self):
        _, accepted, checks = validate_bundle(self.bundle)
        self.assertEqual(len(accepted), 2)
        self.assertTrue(checks["selected_path_capture_checks_pass"])
        self.assertFalse(checks["all_history_branches_verified"])

    def test_tampered_body_fails_hash_verification(self):
        self.bundle["pages"][1]["response"]["body_text"] += " "
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            validate_bundle(self.bundle)

    def test_finished_flag_without_recheck_is_rejected(self):
        self.bundle["pages"].pop()
        with self.assertRaisesRegex(ValueError, "Finished status"):
            validate_bundle(self.bundle)

    def test_false_finished_flag_with_more_pages_is_rejected(self):
        self.bundle["pages"][1] = record(1, "previous", page([A, B], True))
        with self.assertRaisesRegex(ValueError, "Finished status"):
            validate_bundle(self.bundle)

    def test_disconnected_provenance_is_rejected(self):
        self.bundle["pages"][1]["validation"]["parent_page_sequence"] = 9
        with self.assertRaisesRegex(ValueError, "discontinuous"):
            validate_bundle(self.bundle)

    def test_changed_head_is_rejected(self):
        changed = deepcopy(self.head)
        changed["messages"][0]["content"]["parts"] = ["内容改变"]
        self.bundle["pages"][2] = record(2, "head_recheck", changed)
        with self.assertRaisesRegex(ValueError, "Head content changed"):
            validate_bundle(self.bundle)

    def test_partial_capture_is_accepted_as_partial(self):
        self.bundle["capture"]["state"] = "paused"
        self.bundle["pages"] = [record(0, "head", self.head)]
        _, _, checks = validate_bundle(self.bundle)
        self.assertFalse(checks["selected_path_capture_checks_pass"])

    def test_request_headers_are_not_allowed_in_export(self):
        self.bundle["pages"][0]["request"]["headers"] = []
        with self.assertRaisesRegex(ValueError, "without headers"):
            validate_bundle(self.bundle)

    def test_head_without_redundant_identity_is_bound_to_ordinary_request(self):
        value = deepcopy(self.head)
        del value["conversation_id"]
        del value["current_node"]
        self.bundle["pages"][0] = record(0, "head", value)
        self.bundle["pages"][2] = record(2, "head_recheck", value)
        _, _, checks = validate_bundle(self.bundle)
        self.assertTrue(checks["selected_path_capture_checks_pass"])

    def test_a_subresource_or_forced_request_cannot_supply_a_page_head(self):
        for suffix in ["/textdocs", "?include_full_conversation=true&other=1"]:
            bundle = deepcopy(self.bundle)
            bundle["pages"][0]["request"]["url"] += suffix
            with self.assertRaisesRegex(ValueError, "ordinary conversation head"):
                validate_bundle(bundle)

    def test_conflicting_head_identity_is_rejected(self):
        value = {**self.head, "id": A}
        self.bundle["pages"][0] = record(0, "head", value)
        with self.assertRaisesRegex(ValueError, "conflicting"):
            validate_bundle(self.bundle)


if __name__ == "__main__":
    unittest.main()
