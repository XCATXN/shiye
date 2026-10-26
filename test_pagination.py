import unittest
from copy import deepcopy

from pagination import PageRejected, parse_observed_request, validate_previous_page


CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
A = "00000000-0000-4000-8000-000000000001"
B = "00000000-0000-4000-8000-000000000002"
C = "00000000-0000-4000-8000-000000000003"
D = "00000000-0000-4000-8000-000000000004"
URL = f"https://chatgpt.com/backend-api/conversations/{CID}/messages?before={C}&include_has_versions=true&num_turns=10"


def page(ids, earlier=True):
    return {"conversation_id": CID, "messages": [{"id": k} for k in ids],
            "page_info": {"start_cursor": ids[0], "end_cursor": ids[-1],
                          "has_previous_page": earlier, "has_next_page": True}}


class PaginationTests(unittest.TestCase):
    def setUp(self):
        self.later = page([C, D])
        self.previous = page([A, B])

    def expect_rejection(self, code, later=None, previous=None, url=URL, seen=()):
        with self.assertRaises(PageRejected) as captured:
            validate_previous_page(later or self.later, previous or self.previous, url, seen)
        self.assertEqual(captured.exception.code, code)

    def test_actual_cursor_drives_next_url(self):
        result = validate_previous_page(self.later, self.previous, URL)
        self.assertEqual(parse_observed_request(result["next_request_url"])["before"], A)
        self.assertEqual(result["new_message_ids_count"], 2)

    def test_recopying_old_response_is_rejected(self):
        self.expect_rejection("cursor_not_advanced", previous=deepcopy(self.later))

    def test_wrong_request_anchor_is_rejected(self):
        self.expect_rejection("request_cursor_mismatch", url=URL.replace(f"before={C}", f"before={B}"))

    def test_cursor_cycle_is_rejected(self):
        self.expect_rejection("cursor_cycle", seen=[A])

    def test_final_page_does_not_prove_all_branches(self):
        result = validate_previous_page(self.later, page([A, B], earlier=False), URL)
        self.assertIsNone(result["next_request_url"])
        self.assertTrue(result["selected_path_boundary_observed"])
        self.assertFalse(result["whole_conversation_complete"])

    def test_duplicate_parameters_are_rejected(self):
        self.expect_rejection("duplicate_parameter", url=URL + "&before=" + A)

    def test_wrong_conversation_is_rejected(self):
        previous = {**self.previous, "conversation_id": A}
        self.expect_rejection("different_conversation", previous=previous)

    def test_empty_response_is_not_success(self):
        previous = {**self.previous, "messages": []}
        self.expect_rejection("empty_response", previous=previous)


if __name__ == "__main__":
    unittest.main()
