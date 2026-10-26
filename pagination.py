"""Validate the observed messages pagination contract, without network access.

Only the request supplied by the user is supported. No endpoint discovery,
authentication handling, automatic retries, or branch-completeness claims.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID


class PageRejected(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def reject(code, message):
    raise PageRejected(code, message)


def identifier(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        reject("invalid_id", "Expected a complete UUID conversation or cursor id")
    return value


def parse_observed_request(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "chatgpt.com" or parsed.fragment:
        reject("unsupported_origin", "Only the observed HTTPS chatgpt.com request is supported")
    parts = parsed.path.split("/")
    if len(parts) != 5 or parts[1:3] != ["backend-api", "conversations"] or parts[4] != "messages":
        reject("unsupported_path", "Expected /backend-api/conversations/{id}/messages")
    conversation_id = identifier(parts[3])
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    params = dict(pairs)
    if len(params) != len(pairs):
        reject("duplicate_parameter", "Repeated query parameters are ambiguous")
    if set(params) != {"before", "include_has_versions", "num_turns"}:
        reject("unsupported_parameters", "Request parameters differ from the observed sample")
    identifier(params["before"])
    if params["include_has_versions"] != "true" or params["num_turns"] != "10":
        reject("unverified_parameter_values", "Keep the observed true/10 parameter values until tested")
    return {"conversation_id": conversation_id, "before": params["before"],
            "origin": "https://chatgpt.com", "path": parsed.path, "params": params}


def inspect_page(page, conversation_id):
    if not isinstance(page, dict) or not isinstance(page.get("messages"), list):
        reject("unsupported_response", "Expected an object containing messages")
    returned_id = page.get("conversation_id")
    if returned_id is not None and returned_id != conversation_id:
        reject("different_conversation", "Response belongs to a different conversation")
    info = page.get("page_info")
    if not isinstance(info, dict) or type(info.get("has_previous_page")) is not bool:
        reject("invalid_pagination_flags", "Missing an explicit boolean has_previous_page")
    identifiers = []
    for message in page["messages"]:
        if not isinstance(message, dict):
            reject("invalid_message", "Message is not an object")
        identifiers.append(identifier(message.get("id")))
    if not identifiers:
        reject("empty_response", "Empty response needs review; it is not proof of completion")
    if len(set(identifiers)) != len(identifiers):
        reject("duplicate_message_id", "Page contains repeated message ids")
    start, end = identifier(info.get("start_cursor")), identifier(info.get("end_cursor"))
    if start not in identifiers or end not in identifiers:
        reject("boundary_message_missing", "A page boundary cursor is absent from the returned messages")
    return {"start": start, "end": end, "ids": set(identifiers),
            "has_previous_page": info["has_previous_page"],
            "response_conversation_id_present": returned_id is not None}


def validate_previous_page(later_page, previous_page, request_url, seen_start_cursors=()):
    request = parse_observed_request(request_url)
    later = inspect_page(later_page, request["conversation_id"])
    previous = inspect_page(previous_page, request["conversation_id"])
    if not later["has_previous_page"]:
        reject("already_at_boundary", "Later page does not declare earlier history")
    if request["before"] != later["start"]:
        reject("request_cursor_mismatch", "The request is not anchored to the later page's start cursor")
    if previous["start"] == request["before"]:
        reject("cursor_not_advanced", "Response start cursor did not move; likely the old response was copied")
    if previous["start"] in set(seen_start_cursors):
        reject("cursor_cycle", "Response repeats a start cursor already visited")
    new_ids = previous["ids"] - later["ids"]
    if not new_ids:
        reject("no_new_messages", "Response contains no additional message ids")
    params = {**request["params"], "before": previous["start"]}
    next_url = None
    if previous["has_previous_page"]:
        next_url = urlunsplit(("https", "chatgpt.com", request["path"], urlencode(params), ""))
    return {"request_cursor_link_valid": True, "new_message_ids_count": len(new_ids),
            "previous_start_cursor": previous["start"], "next_request_url": next_url,
            "selected_path_boundary_observed": not previous["has_previous_page"],
            "response_conversation_id_present": previous["response_conversation_id_present"],
            "whole_conversation_complete": False,
            "scope": "Checks a supplied request/response pair; capture provenance and all branches remain unverified"}
