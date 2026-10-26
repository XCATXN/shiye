import json
from pathlib import Path
import tempfile
import unittest

from audit_exports import audit, read_document


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name).resolve()
        if not self.folder.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("Refusing cleanup outside the system temporary directory")
        self.addCleanup(self.temp.cleanup)
        self.message = {"id": "m1", "author": {"role": "user", "name": None},
                        "content": {"content_type": "text", "parts": ["原文，保留空格。 "]},
                        "create_time": 1.0}
        self.reference = self.write("reference.json", {"conversation_id": "c1", "title": "测试",
            "mapping": {"m1": {"id": "m1", "parent": None, "message": self.message}}})

    def write(self, name, value):
        path = self.folder / name
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        return path

    def page(self, name="page.json", message=None, conversation="c1"):
        return self.write(name, {"conversation_id": conversation,
            "messages": [self.message if message is None else message],
            "page_info": {"has_previous_page": False, "has_next_page": False}})

    def test_covered_reference_and_terminal_page_do_not_prove_complete_conversation(self):
        report = audit(self.reference, [self.page()])
        self.assertTrue(report["checks"]["reference_message_payloads_fully_covered"])
        self.assertTrue(report["checks"]["earliest_page_boundary_observed"])
        self.assertFalse(report["checks"]["capture_ready_for_complete_backup_claim"])
        self.assertEqual(report["checks"]["complete_branch_structure"], "not_verified")

    def test_web_metadata_does_not_make_identical_story_content_different(self):
        enriched = {**self.message, "metadata": {"parent_id": "different_internal_id"}}
        report = audit(self.reference, [self.page(message=enriched)])
        self.assertTrue(report["checks"]["reference_message_payloads_fully_covered"])
        self.assertEqual(report["overlap"]["different_full_record_count"], 1)

    def test_trailing_whitespace_change_is_not_silently_normalized(self):
        modified = {**self.message, "content": {"content_type": "text", "parts": ["原文，保留空格。"]}}
        report = audit(self.reference, [self.page(message=modified)])
        self.assertEqual(report["changed_content_ids"], ["m1"])
        self.assertFalse(report["checks"]["reference_message_payloads_fully_covered"])

    def test_conflicting_repeat_across_pages_cannot_pass(self):
        modified = {**self.message, "content": {"content_type": "text", "parts": ["另一个版本"]}}
        report = audit(self.reference, [self.page(), self.page("second.json", modified)])
        self.assertEqual(report["same_id_payload_conflicts"], ["m1"])
        self.assertFalse(report["checks"]["reference_message_payloads_fully_covered"])

    def test_overlapping_identical_pages_are_deduplicated(self):
        report = audit(self.reference, [self.page(), self.page("second.json")])
        self.assertEqual(report["captured"]["records"], 1)
        self.assertEqual(report["same_id_payload_conflicts"], [])

    def test_wrong_conversation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "different conversation"):
            audit(self.reference, [self.page(conversation="c2")])

    def test_duplicate_json_keys_are_rejected(self):
        path = self.folder / "duplicate.json"
        path.write_text('{"messages": [], "messages": []}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate JSON"):
            read_document(path)


if __name__ == "__main__":
    unittest.main()
